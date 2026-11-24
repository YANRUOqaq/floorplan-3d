/** 3D 里点中家具后左下角弹出的信息卡：名称、规格、尺寸、价格、备注 */
import { CATALOG_BY_TYPE } from "../model/catalog";
import type { App } from "./app";
import { esc, fmtExact } from "./dom";

export function priceTag(it: { price?: number; priceBasis?: "user" | "llm"; optional?: boolean; fixed?: boolean }) {
  if (it.fixed) return '<span class="tag">原有，不计预算</span>';
  if (it.price == null) return '<span class="tag">不计预算</span>';
  return `<span class="price">${fmtExact(it.price)}</span> ${it.priceBasis === "llm" ? '<span class="tag warn">大模型估算，未核实</span>' : '<span class="tag ok">自填</span>'}${it.optional ? ' <span class="tag opt">可选</span>' : ""}`;
}

export function renderInfo(app: App, box: HTMLElement) {
  const it = app.selected ? app.store.house.furniture.find(f => f.id === app.selected) : null;
  if (!it) { box.hidden = true; return; }
  const cat = CATALOG_BY_TYPE[it.type];
  const cm = (v: number) => Math.round(v * 100);
  box.innerHTML = `
    <div class="row1"><h3>${esc(it.name || cat?.nameZh || it.type)}</h3><button type="button" class="x" aria-label="关闭">×</button></div>
    <div class="meta">${esc(cat?.nameZh ?? it.type)} · ${cm(it.size[0])}×${cm(it.size[1])}×${cm(it.size[2])} cm${it.spec ? " · " + esc(it.spec) : ""}</div>
    <div>${priceTag(it)}</div>
    ${it.note ? `<div class="meta">${esc(it.note)}</div>` : ""}
    <div class="links"><button type="button" class="link" data-act="edit">在 2D 里改</button>${it.price != null ? '<button type="button" class="link" data-act="list">在清单里看</button>' : ""}</div>`;
  box.hidden = false;
  box.onclick = e => {
    const t = e.target as HTMLElement;
    if (t.closest(".x")) app.select(null);
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "list") app.showSide("list");
    if (act === "edit") app.showTab("2d");
  };
}
