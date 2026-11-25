/**
 * “出效果图”对话框：选画面和清晰度，渲染时边算边显示，完成后下载 PNG。
 * 渲染模块（three/render.ts）连同 WebGPU 路径追踪库只在第一次点“开始”时加载。
 */
import type { App } from "./app";
import { $, download, esc } from "./dom";
import { loadSettings } from "../llm/providers";
import { dashscopeOrigin, refineImage, refineSize } from "../llm/refine";

type Kind = "still" | "pano";
const NO_WEBGPU = "这个浏览器不支持 WebGPU，出不了效果图。请用电脑上最新版的 Chrome 或 Edge。3D 浏览和其他功能不受影响。";
/** 清晰度：长边像素和每个像素的采样次数。数值按 2026-11-25 RX 7800 XT 实测定：标准约 15 秒，高清约 40 秒，标准全景约 22 秒 */
export const PRESETS: Record<Kind, Record<"std" | "hd", { long: number; samples: number; label: string }>> = {
  still: { std: { long: 1280, samples: 64, label: "标准（1280 像素）" }, hd: { long: 1920, samples: 128, label: "高清（1920 像素）" } },
  pano: { std: { long: 2048, samples: 64, label: "标准（2048×1024）" }, hd: { long: 4096, samples: 64, label: "高清（4096×2048）" } },
};

/** 出图尺寸：长边定长，按画面的宽高比算短边；全景固定宽是高的两倍 */
export function outputSize(kind: Kind, longEdge: number, aspect: number): [number, number] {
  if (kind === "pano") return [longEdge, longEdge / 2];
  return aspect >= 1 ? [longEdge, Math.round(longEdge / aspect)] : [Math.round(longEdge * aspect), longEdge];
}

export function initRenderDialog(app: App) {
  const dlg = $<HTMLDialogElement>("#render-dlg");
  dlg.innerHTML = `
    <div class="rd-head"><h3>出效果图</h3><button type="button" class="btn small" data-close>关闭</button></div>
    <div class="row">
      <label class="rd-field">画面 <select id="rd-kind"><option value="still">当前视角</option><option value="pano">720 全景（站在房间里时）</option></select></label>
      <label class="rd-field">清晰度 <select id="rd-size"></select></label>
      <button type="button" class="btn primary" id="rd-start">开始</button>
      <button type="button" class="btn" id="rd-stop" hidden>停止</button>
      <button type="button" class="btn" id="rd-save" hidden>下载 PNG</button>
      <button type="button" class="btn" id="rd-ai" hidden>AI 精修</button>
      <span class="row" id="rd-ai-view" hidden><button type="button" class="btn small" data-show="render" aria-pressed="false">看效果图</button><button type="button" class="btn small" data-show="ai" aria-pressed="true">看 AI 精修</button><a class="note" id="rd-ai-link" target="_blank" rel="noopener">打开大图</a></span>
    </div>
    <div class="rd-view"><canvas id="rd-canvas"></canvas><img id="rd-ai-img" alt="AI 精修结果" hidden></div>
    <p class="note" id="rd-status" aria-live="polite"></p>`;
  const kindSel = $<HTMLSelectElement>("#rd-kind", dlg), sizeSel = $<HTMLSelectElement>("#rd-size", dlg);
  const status = $("#rd-status", dlg), startBtn = $<HTMLButtonElement>("#rd-start", dlg), stopBtn = $("#rd-stop", dlg), saveBtn = $("#rd-save", dlg);
  const aiBtn = $<HTMLButtonElement>("#rd-ai", dlg), aiView = $("#rd-ai-view", dlg), aiImg = $<HTMLImageElement>("#rd-ai-img", dlg), aiLink = $<HTMLAnchorElement>("#rd-ai-link", dlg);
  let canvas = $<HTMLCanvasElement>("#rd-canvas", dlg);
  let busy: AbortController | null = null, result: { blob: Blob; name: string; size?: [number, number] } | null = null;
  const idleText = "用你这台设备的显卡在浏览器里渲染，不上传任何东西。光线在屋里多次反弹，比 3D 浏览的画面真实，一张要几十秒。";

  const fillSizes = () => {
    const p = PRESETS[kindSel.value as Kind];
    sizeSel.innerHTML = (["std", "hd"] as const).map(k => `<option value="${k}">${esc(p[k].label)}</option>`).join("");
  };
  kindSel.addEventListener("change", () => {
    fillSizes();
    if (!busy) status.textContent = kindSel.value === "pano" ? "全景在你现在站的位置拍。站在墙角只能看到半个房间，先在 3D 里点地面走到房间中间再出图效果更好。" : idleText;
  });

  async function start() {
    const shot = app.viewer.shot();
    if (!shot) return;
    const kind = kindSel.value as Kind;
    if (kind === "pano" && shot.orbit) { status.textContent = "720 全景要站在房间里出：先点上面“站到”里的一个房间。"; return; }
    const preset = PRESETS[kind][sizeSel.value as "std" | "hd"];
    const [w, h] = outputSize(kind, preset.long, shot.aspect);
    // 每次换一块新画布：一块画布只能绑定一个 WebGPU 上下文
    const fresh = document.createElement("canvas");
    fresh.id = "rd-canvas"; fresh.width = w; fresh.height = h;
    canvas.replaceWith(fresh); canvas = fresh;
    result = null; saveBtn.hidden = true; startBtn.hidden = true; stopBtn.hidden = false;
    aiBtn.hidden = true; aiView.hidden = true; aiImg.hidden = true; aiImg.removeAttribute("src");
    kindSel.disabled = sizeSel.disabled = true;
    busy = new AbortController();
    status.textContent = "加载渲染程序……";
    try {
      const r = await import("../three/render");
      if (!(await r.webgpuReady())) throw new Error(NO_WEBGPU);
      const sec = (ms: number) => Math.round(ms / 1000);
      const blob = await r.renderShot(shot, {
        kind, width: w, height: h, samples: preset.samples, canvas, signal: busy.signal,
        onProgress: p => {
          status.textContent = p.stage === "渲染"
            ? `渲染中：每个像素已采样 ${p.samples} / ${preset.samples} 次 · 已用 ${sec(p.elapsed)} 秒`
            : `${p.stage}…… · 已用 ${sec(p.elapsed)} 秒`;
        },
      });
      const view = app.viewer.views.find(v => v.key === app.viewer.currentView)?.name ?? "";
      result = { blob, name: `${shot.house.name}-${kind === "pano" ? "全景" : "效果图"}${view ? "-" + view : ""}.png` };
      status.textContent = `完成：${w}×${h}。${kind === "pano" ? "全景图可以用支持 720 全景的看图软件或网站打开。" : ""}`;
      saveBtn.hidden = false;
      aiBtn.hidden = kind !== "still";
      result.size = [w, h];
    } catch (e) {
      const err = e as Error;
      status.textContent = err.name === "AbortError" ? "已停止。" : `出图失败：${err.message}`;
    } finally {
      busy = null; startBtn.hidden = false; stopBtn.hidden = true;
      kindSel.disabled = sizeSel.disabled = false;
    }
  }

  startBtn.addEventListener("click", start);

  /* AI 精修：用“大模型”面板里填的通义千问 Key，把刚出的效果图交给图像编辑模型 */
  const showAi = (ai: boolean) => {
    canvas.hidden = ai; aiImg.hidden = !ai;
    aiView.querySelectorAll<HTMLElement>("[data-show]").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.show === "ai") === ai)));
  };
  aiView.addEventListener("click", e => { const b = (e.target as HTMLElement).closest<HTMLElement>("[data-show]"); if (b) showAi(b.dataset.show === "ai"); });
  aiBtn.addEventListener("click", async () => {
    if (!result?.size || busy) return;
    const s = loadSettings();
    if (!dashscopeOrigin(s.baseURL) || !s.apiKey || !s.imageModel) {
      status.textContent = "AI 精修要用通义千问（阿里云百炼）的图像编辑模型：先在右侧“大模型”面板选这家厂商、填 Key 和图像模型。";
      return;
    }
    busy = new AbortController(); aiBtn.disabled = startBtn.disabled = true;
    const t0 = Date.now(), tick = setInterval(() => { status.textContent = `AI 精修中……已等 ${Math.round((Date.now() - t0) / 1000)} 秒（按厂商价格计费，每张约 0.1～0.5 元）`; }, 1000);
    try {
      const size = refineSize(...result.size);
      const url = await refineImage(s, await toJpegDataUrl(result.blob, size), size, { signal: busy.signal });
      aiImg.src = url; aiLink.href = url;
      aiView.hidden = false; showAi(true);
      status.textContent = "AI 精修是示意图：图像模型会重新画一遍，家具的款式、细节甚至数量可能和方案不一样，不对应采购清单。结果图由厂商保存约 24 小时，要留着请打开大图另存。";
    } catch (e) {
      const err = e as Error;
      status.textContent = err.name === "AbortError" ? "已停止。" : err.message;
    } finally { clearInterval(tick); busy = null; aiBtn.disabled = startBtn.disabled = false; }
  });
  stopBtn.addEventListener("click", () => busy?.abort());
  saveBtn.addEventListener("click", () => { if (result) download(result.name, result.blob, "image/png"); });
  dlg.querySelector("[data-close]")!.addEventListener("click", () => dlg.close());
  // 关掉对话框（关闭按钮、Esc）就停止渲染
  dlg.addEventListener("close", () => busy?.abort());

  $("#btn-render").addEventListener("click", () => {
    fillSizes();
    // 先粗查一下，免得点了开始、加载完几 MB 的库才说不支持；能不能拿到显卡要到开始时才知道
    const supported = "gpu" in navigator && !!navigator.gpu;
    startBtn.disabled = !supported;
    if (!busy) status.textContent = supported ? idleText : NO_WEBGPU;
    dlg.showModal();
  });
}

/** 效果图转成 JPEG 的 data URL（发给图像模型用，比 PNG 小得多），顺便缩到要的尺寸 */
async function toJpegDataUrl(png: Blob, [w, h]: [number, number]): Promise<string> {
  const bmp = await createImageBitmap(png);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.9);
}
