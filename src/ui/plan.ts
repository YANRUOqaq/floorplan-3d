/** 右侧“方案”面板：整体风格、各房间（点了在 3D 里站过去）、家具列表 */
import { THEME_IDS } from "../model/schema";
import { polygonArea } from "../model/geometry";
import { CATALOG_BY_TYPE } from "../model/catalog";
import { THEMES } from "../model/themes";
import type { App } from "./app";
import { esc } from "./dom";
import { renderProps } from "./props";

export function renderPlanPanel(app: App, box: HTMLElement) {
  const h = app.store.house;
  const rooms = h.rooms.map(r => {
    const n = h.furniture.filter(f => f.room === r.id).length;
    return `<li><button type="button" data-room="${esc(r.id)}"><span>${esc(r.name)}</span><span class="muted mono">${polygonArea(r.polygon).toFixed(1)}㎡ · ${n} 件</span></button></li>`;
  }).join("");
  const items = h.furniture.map(f => `<li><button type="button" data-item="${esc(f.id)}" aria-current="${f.id === app.selected}"><span>${esc(f.name || CATALOG_BY_TYPE[f.type]?.nameZh || f.type)}</span><span class="muted">${esc(h.rooms.find(r => r.id === f.room)?.name ?? "")}</span></button></li>`).join("");
  box.innerHTML = `
    <section class="card props" id="props" hidden></section>
    <button type="button" class="btn" data-furnish>布置家具…</button>
    <section class="field"><h3>整体风格</h3>
      <div class="themes">${THEME_IDS.map(id => {
        const t = THEMES[id];
        return `<button type="button" class="theme" data-theme-id="${id}" aria-pressed="${h.theme === id}" title="${esc(t.desc)}">
          <span>${esc(t.nameZh)}</span><span class="swatches"><i style="background:${t.floorColor}"></i><i style="background:${t.fabric}"></i><i style="background:${t.accent}"></i><i style="background:${t.wallColor}"></i></span></button>`;
      }).join("")}</div>
      <p class="note">风格决定没单独设颜色的家具、地板和墙面用什么颜色。</p>
    </section>
    <section class="field"><h3>房间（${h.rooms.length}）</h3>${h.rooms.length ? `<ul class="list">${rooms}</ul>` : '<p class="note">还没有房间。</p>'}</section>
    <section class="field"><h3>家具（${h.furniture.length}）</h3>${h.furniture.length ? `<ul class="list">${items}</ul>` : '<p class="note">还没有家具。可以在 2D 编辑里放，也可以让大模型布置。</p>'}</section>`;
  renderProps(app, box.querySelector("#props") as HTMLElement);
  box.onclick = e => {
    const t = e.target as HTMLElement;
    if (t.closest("#props")) return;
    if (t.closest("[data-furnish]")) { app.furnish(); return; }
    const th = t.closest<HTMLElement>("[data-theme-id]")?.dataset.themeId;
    if (th && th !== h.theme) app.store.commit("换风格", d => { d.theme = th as typeof d.theme; });
    const room = t.closest<HTMLElement>("[data-room]")?.dataset.room;
    if (room) { app.showTab("3d"); app.viewer.setView(room); }
    const item = t.closest<HTMLElement>("[data-item]")?.dataset.item;
    if (item) app.select(item);
  };
}
