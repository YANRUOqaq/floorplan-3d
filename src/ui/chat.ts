/**
 * 右侧“大模型”面板：模型设置（Key 只存在本机浏览器）、对话、修改预览、应用。
 * 大模型的修改先在草稿上试套用，列出要改什么、有哪些摆放问题，用户点“应用”才提交，提交后可以撤销。
 */
import { applyOps, type ApplyResult } from "../model/ops";
import { askAssistant, type Turn } from "../llm/agent";
import { LlmError, listModels } from "../llm/client";
import { clearKey, loadSettings, PROVIDERS, saveSettings, type LlmSettings } from "../llm/providers";
import type { LlmReply } from "../model/ops";
import type { App } from "./app";
import { esc, toast } from "./dom";

interface Msg { role: "user" | "assistant" | "error"; text: string; reply?: LlmReply; preview?: ApplyResult | null; repaired?: boolean; state?: "pending" | "applied" | "dismissed" }

const QUICK = [
  "按房间用途把空着的房间布置好，尺寸要放得下，不要挡门",
  "整体换成奶油风",
  "给没标价的家具估个价，再补上床垫、床品这些清单项",
  "检查一下有没有家具挡门或者太挤，帮我调整",
];

export function initChat(app: App, box: HTMLElement) {
  let s = loadSettings();
  const msgs: Msg[] = [];
  const turns: Turn[] = [];
  let busy: AbortController | null = null;

  box.innerHTML = `
    <details class="card llm-set" id="llm-set">
      <summary id="llm-sum"></summary>
      <div class="props-grid">
        <label class="field wide"><span>厂商</span><select id="llm-provider">${PROVIDERS.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label>
        <label class="field wide"><span>接口地址（Base URL）</span><input type="url" id="llm-base" placeholder="https://…/v1"></label>
        <label class="field"><span>模型</span><input type="text" id="llm-model" list="llm-models"></label>
        <label class="field"><span>识图模型（户型图识别用）</span><input type="text" id="llm-vmodel" list="llm-models" placeholder="不用识图可以空着"></label>
        <label class="field wide"><span>图像模型（出效果图里的 AI 精修用，目前只支持通义千问）</span><input type="text" id="llm-imodel" list="llm-models" placeholder="不用可以空着"></label>
        <datalist id="llm-models"></datalist>
        <label class="field wide"><span>API Key</span><input type="password" id="llm-key" autocomplete="off" spellcheck="false"></label>
      </div>
      <div class="row"><button type="button" class="btn small" id="llm-list">获取模型列表</button><button type="button" class="btn small danger" id="llm-clear">清除 Key</button><a id="llm-keyurl" target="_blank" rel="noopener" class="note">去哪里申请 Key</a></div>
      <p class="note">Key 只保存在这个浏览器里。提问时，户型数据（墙、房间、家具）和你说的话会直接发给上面这家厂商；本站没有服务器，不经手这些数据。在公用电脑上用完请点“清除 Key”。调用按厂商价格计费。</p>
    </details>
    <div class="chat-log" id="chat-log" aria-live="polite"></div>
    <div class="chips chat-quick">${QUICK.map(q => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    <form class="chat-input" id="chat-form">
      <textarea id="chat-text" rows="3" placeholder="比如：主卧按原木风布置，床 1.5 m，预算 5000 以内"></textarea>
      <div class="row"><button type="submit" class="btn primary" id="chat-send">发送</button><button type="button" class="btn" id="chat-stop" hidden>停止</button><span class="note" id="chat-status"></span></div>
    </form>`;
  const q = <T extends HTMLElement>(sel: string) => box.querySelector(sel) as T;
  const fields = { provider: q<HTMLSelectElement>("#llm-provider"), base: q<HTMLInputElement>("#llm-base"), model: q<HTMLInputElement>("#llm-model"), vmodel: q<HTMLInputElement>("#llm-vmodel"), imodel: q<HTMLInputElement>("#llm-imodel"), key: q<HTMLInputElement>("#llm-key") };

  /* ---------- 设置 ---------- */
  function showSettings() {
    fields.provider.value = s.provider; fields.base.value = s.baseURL; fields.model.value = s.model; fields.vmodel.value = s.visionModel; fields.imodel.value = s.imageModel; fields.key.value = s.apiKey;
    const p = PROVIDERS.find(p => p.id === s.provider);
    q<HTMLAnchorElement>("#llm-keyurl").hidden = !p?.keyUrl;
    if (p?.keyUrl) q<HTMLAnchorElement>("#llm-keyurl").href = p.keyUrl;
    q("#llm-sum").innerHTML = `模型设置：${esc(p?.name ?? "自定义")} · ${esc(s.model || "未填模型")} · ${s.apiKey ? '<span class="tag ok">Key 已填</span>' : '<span class="tag warn">还没填 Key</span>'}`;
    if (!s.apiKey) (q("#llm-set") as HTMLDetailsElement).open = true;
  }
  function readSettings(): LlmSettings {
    return { provider: fields.provider.value, baseURL: fields.base.value.trim(), model: fields.model.value.trim(), visionModel: fields.vmodel.value.trim(), imageModel: fields.imodel.value.trim(), apiKey: fields.key.value.trim() };
  }
  fields.provider.addEventListener("change", () => {
    const p = PROVIDERS.find(p => p.id === fields.provider.value)!;
    s = { ...readSettings(), provider: p.id, baseURL: p.baseURL, model: p.model, visionModel: p.visionModel, imageModel: p.imageModel };
    saveSettings(s); showSettings();
  });
  for (const f of [fields.base, fields.model, fields.vmodel, fields.imodel, fields.key]) f.addEventListener("change", () => { s = readSettings(); saveSettings(s); showSettings(); });
  q("#llm-clear").addEventListener("click", () => { clearKey(); s = loadSettings(); showSettings(); toast("已从这个浏览器里清除 Key。"); });
  q("#llm-list").addEventListener("click", async () => {
    try {
      const ids = await listModels(readSettings());
      q("#llm-models").innerHTML = ids.map(id => `<option value="${esc(id)}">`).join("");
      toast(ids.length ? `读到 ${ids.length} 个模型，在“模型”输入框里可以选。` : "厂商没返回模型列表，请按厂商文档手动填写。");
    } catch (e) { toast((e as Error).message, true); }
  });
  showSettings();

  /* ---------- 对话 ---------- */
  const log = q("#chat-log");
  function render() {
    log.innerHTML = msgs.length ? msgs.map((m, i) => {
      if (m.role === "user") return `<div class="msg user">${esc(m.text)}</div>`;
      if (m.role === "error") return `<div class="msg err">${esc(m.text)}</div>`;
      const p = m.preview;
      const body = p ? `
        <ul class="ops">${p.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>
        ${p.errors.length ? `<div class="note">跳过了 ${p.errors.length} 条：</div><ul class="ops bad">${p.errors.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
        ${p.warnings.length ? `<div class="note">要留意（照样可以应用，摆放问题之后在 2D 里拖一下）：</div><ul class="ops warn">${p.warnings.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
        ${m.state === "pending" ? `<div class="row"><button type="button" class="btn small primary" data-apply="${i}">应用这些修改</button><button type="button" class="btn small" data-dismiss="${i}">不用了</button></div>`
          : m.state === "applied" ? '<p class="note">已应用。不满意可以点顶栏的“撤销”。</p>' : '<p class="note">没有应用。</p>'}` : "";
      return `<div class="msg ai"><div>${esc(m.text)}</div>${m.repaired ? '<p class="note">第一次回复的格式不对，已经让它自动改了一次。</p>' : ""}${body}</div>`;
    }).join("") : `<p class="note">告诉大模型你想怎么布置，它会给出修改清单，你确认后才会改到方案里。它看得到当前的户型和家具，看不到你的户型图。</p>`;
    log.scrollTop = log.scrollHeight;
  }
  log.addEventListener("click", e => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>("[data-apply]")?.dataset.apply, d = t.closest<HTMLElement>("[data-dismiss]")?.dataset.dismiss;
    if (a != null) {
      const m = msgs[+a];
      try {
        // 在当前方案上重新套一遍：提问之后用户可能又手动改过
        const r = applyOps(app.store.house, m.reply!.ops);
        app.store.replace(r.house, "大模型修改");
        m.state = "applied";
        if (r.touched[0]) app.select(r.touched[0]);
        toast(`已应用 ${r.lines.length} 条修改。`);
      } catch (err) { toast((err as Error).message, true); }
      render();
    }
    if (d != null) { msgs[+d].state = "dismissed"; render(); }
  });

  const text = q<HTMLTextAreaElement>("#chat-text");
  async function send(content: string) {
    content = content.trim(); if (!content || busy) return;
    s = readSettings(); saveSettings(s);
    if (!s.apiKey) { (q("#llm-set") as HTMLDetailsElement).open = true; toast("先在上面填 API Key。", true); return; }
    msgs.push({ role: "user", text: content }); render();
    text.value = "";
    busy = new AbortController();
    q("#chat-send").hidden = true; q("#chat-stop").hidden = false;
    // 显示已等的秒数：2026-11-24 用通义千问实测一般 10 到 20 秒，网络不好时等过 3 分多钟，光写“在想”分不清是不是卡住了
    const t0 = Date.now(), tick = () => { q("#chat-status").textContent = `大模型在想……已等 ${Math.round((Date.now() - t0) / 1000)} 秒`; };
    tick();
    const timer = setInterval(tick, 1000);
    try {
      const r = await askAssistant(s, app.store.house, turns, content, { signal: busy.signal });
      turns.push({ role: "user", text: content }, { role: "assistant", text: r.reply.reply });
      msgs.push({ role: "assistant", text: r.reply.reply, reply: r.reply, preview: r.preview, repaired: r.repaired, state: r.preview ? "pending" : undefined });
    } catch (e) {
      if ((e as Error).name === "AbortError") msgs.push({ role: "error", text: "已停止。" });
      else msgs.push({ role: "error", text: e instanceof LlmError ? e.message : `出错了：${(e as Error).message}` });
    } finally {
      clearInterval(timer);
      busy = null; q("#chat-send").hidden = false; q("#chat-stop").hidden = true; q("#chat-status").textContent = "";
      render();
    }
  }
  q("#chat-form").addEventListener("submit", e => { e.preventDefault(); send(text.value); });
  text.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(text.value); } });
  q("#chat-stop").addEventListener("click", () => busy?.abort());
  box.querySelector(".chat-quick")!.addEventListener("click", e => { const b = (e.target as HTMLElement).closest<HTMLElement>("[data-q]"); if (b) text.value = b.dataset.q!; text.focus(); });
  render();
}
