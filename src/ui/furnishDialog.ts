/**
 * “布置家具”对话框：选整体风格 → 程序按房间用途自动摆好常用家具（model/furnish.ts，不用大模型、不花钱）
 * → 可选：把用户的想法交给大模型，在自动布置的基础上增删改、估价格。
 *
 * 为什么先用规则摆、再让大模型改：大模型一次摆整套房子常漏东西、挡门挡窗，效果看模型好坏；
 * 规则摆法保证每个房间齐全、不挡门窗、不重叠，大模型只管个性化的部分（2026-11-25 定）。
 */
import { THEME_IDS, type House } from "../model/schema";
import { THEMES } from "../model/themes";
import { furnishHouse } from "../model/furnish";
import { applyOps } from "../model/ops";
import type { App } from "./app";
import { $, esc, toast } from "./dom";

export function initFurnishDialog(app: App, chat: { send(text: string): Promise<void>; hasKey(): boolean }) {
  const dlg = $<HTMLDialogElement>("#furnish-dlg");
  let theme: House["theme"] = app.store.house.theme;
  dlg.innerHTML = `
    <div class="rd-head"><h3>布置家具</h3><button type="button" class="btn small" data-close>关闭</button></div>
    <p class="note">程序按房间用途摆好常用家具：床和床头柜、衣柜、沙发和电视柜、餐桌椅、灯、地毯、窗帘……保证不挡门窗、不重叠。之后可以在 2D 里拖动，也可以让大模型按你的想法改。</p>
    <div class="field"><h3>整体风格</h3><div class="themes" id="fd-themes"></div></div>
    <label class="fd-check"><input type="checkbox" id="fd-clear"> 先清空现有家具（房子原有的设施保留）</label>
    <label class="field wide"><span>还有什么想法？（可选，交给大模型在自动布置的基础上改；要在“大模型”面板填 Key）</span>
      <textarea id="fd-text" rows="3" placeholder="比如：次卧做书房；主卧加梳妆台；预算两万以内"></textarea></label>
    <label class="fd-check"><input type="checkbox" id="fd-price" checked> 让大模型估价格、补上床垫床品这些清单项</label>
    <div class="row"><button type="button" class="btn primary" id="fd-go">开始布置</button><span class="note" id="fd-note"></span></div>`;
  const themes = $("#fd-themes", dlg), clear = $<HTMLInputElement>("#fd-clear", dlg), text = $<HTMLTextAreaElement>("#fd-text", dlg), price = $<HTMLInputElement>("#fd-price", dlg);
  const drawThemes = () => {
    themes.innerHTML = THEME_IDS.map(id => {
      const t = THEMES[id];
      return `<button type="button" class="theme" data-theme-id="${id}" aria-pressed="${id === theme}" title="${esc(t.desc)}"><span>${esc(t.nameZh)}</span>
        <span class="swatches"><i style="background:${t.floorColor}"></i><i style="background:${t.fabric}"></i><i style="background:${t.accent}"></i><i style="background:${t.wallColor}"></i></span></button>`;
    }).join("");
  };
  themes.addEventListener("click", e => { const id = (e.target as HTMLElement).closest<HTMLElement>("[data-theme-id]")?.dataset.themeId; if (id) { theme = id as House["theme"]; drawThemes(); } });
  dlg.querySelector("[data-close]")!.addEventListener("click", () => dlg.close());

  $("#fd-go", dlg).addEventListener("click", () => {
    const h = app.store.house;
    if (!h.rooms.length) { toast("还没有房间。先在 2D 编辑里描出房间，或者上传户型图识别。", true); return; }
    let base = structuredClone(h);
    base.theme = theme;
    if (clear.checked) base = { ...base, furniture: base.furniture.filter(f => f.fixed), extras: [] };
    const r = furnishHouse(base);
    const res = applyOps(base, r.ops);
    app.store.replace(res.house, "自动布置");
    dlg.close();
    app.showTab("3d");
    // 放不下的东西要告诉用户（规则布置器在说明里写了原因）
    const missed = r.notes.filter(n => /未放|不足|改成|采用/.test(n));
    toast(`已布置 ${r.ops.length} 件家具，可以撤销。${missed.length ? "\n" + missed.join("\n") : ""}`, false, missed.length ? 9000 : 4000);
    const want = text.value.trim();
    if (!chat.hasKey()) { if (want) toast("想法要交给大模型：先在右侧“大模型”面板填 Key，再把想法发给它。", true); return; }
    const ask = [want, price.checked ? "给没标价的家具估个价，再补上床垫、床品这些清单项" : ""].filter(Boolean).join("；另外");
    if (ask) { app.showSide("ai"); chat.send(ask); }
  });

  return {
    open() {
      theme = app.store.house.theme; drawThemes();
      clear.checked = false;
      const key = chat.hasKey();
      price.disabled = !key;
      $("#fd-note", dlg).textContent = key ? "" : "没填 Key：只做自动布置，想法和估价要在“大模型”面板填 Key 后再发。";
      dlg.showModal();
    },
  };
}
