/**
 * “出效果图”对话框：选画面和清晰度，渲染时边算边显示，完成后下载 PNG。
 * 渲染模块（three/render.ts）连同 WebGPU 路径追踪库只在第一次点“开始”时加载。
 */
import type { App } from "./app";
import { $, download, esc } from "./dom";

type Kind = "still" | "pano";
const NO_WEBGPU = "这个浏览器不支持 WebGPU，出不了效果图。请用电脑上最新版的 Chrome 或 Edge。3D 浏览和其他功能不受影响。";
/** 清晰度：长边像素和每个像素的采样次数。数值按 2026-11-25 RX 7800 XT 实测定：标准约 15 秒，高清约 30 秒（全景约 1 分钟） */
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
    </div>
    <div class="rd-view"><canvas id="rd-canvas"></canvas></div>
    <p class="note" id="rd-status" aria-live="polite"></p>`;
  const kindSel = $<HTMLSelectElement>("#rd-kind", dlg), sizeSel = $<HTMLSelectElement>("#rd-size", dlg);
  const status = $("#rd-status", dlg), startBtn = $<HTMLButtonElement>("#rd-start", dlg), stopBtn = $("#rd-stop", dlg), saveBtn = $("#rd-save", dlg);
  let canvas = $<HTMLCanvasElement>("#rd-canvas", dlg);
  let busy: AbortController | null = null, result: { blob: Blob; name: string } | null = null;
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
    } catch (e) {
      const err = e as Error;
      status.textContent = err.name === "AbortError" ? "已停止。" : `出图失败：${err.message}`;
    } finally {
      busy = null; startBtn.hidden = false; stopBtn.hidden = true;
      kindSel.disabled = sizeSel.disabled = false;
    }
  }

  startBtn.addEventListener("click", start);
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
