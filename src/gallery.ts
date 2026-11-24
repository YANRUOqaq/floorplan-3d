/**
 * 家具库陈列页：把目录里的每种家具（每个变体）按网格摆在一个大房间里，用同一个 3D 浏览器看。
 * 开发家具外形时用它逐件检查，部署后也给用户看有哪些家具可用。
 */
import "./style.css";
import { CATALOG } from "./model/catalog";
import { parseHouse, type Item } from "./model/schema";
import { Viewer } from "./three/viewer";
import { $, esc } from "./ui/dom";

const items: Item[] = [];
const COLS = 8, CELL = 2.6;
let k = 0;
for (const c of CATALOG) for (const variant of c.variants ?? [""]) {
  const size: [number, number, number] = c.type === "folding_bed" && variant === "open" ? [0.9, 1.9, 0.5] : [...c.defaultSize];
  const col = k % COLS, row = Math.floor(k / COLS); k++;
  const elevation = c.mount === "ceiling" ? 1.6 : undefined;
  items.push({
    id: `${c.type}${variant ? "-" + variant : ""}`, type: c.type, name: c.nameZh + (variant ? `（${variant}）` : ""),
    room: "hall", pos: [col * CELL + CELL / 2, row * CELL + CELL / 2], rot: 0, size, variant: variant || undefined, elevation,
  });
}
const W = COLS * CELL, D = Math.ceil(k / COLS) * CELL;
const house = parseHouse({
  version: 1, name: "家具库", height: 2.75,
  walls: [],
  rooms: [{ id: "hall", name: "家具库", type: "other", polygon: [[0, 0], [W, 0], [W, D], [0, D]], floor: "wood", wall: "paint" }],
  furniture: items,
});

$("#count").textContent = `${CATALOG.length} 种，${items.length} 件`;
const info = $("#info");
const viewer = new Viewer($("#viewer"), {
  onSelect: id => {
    viewer.highlight(id);
    const it = items.find(i => i.id === id);
    if (!it) { info.hidden = true; return; }
    const cm = (v: number) => Math.round(v * 100);
    info.innerHTML = `<div class="row1"><h3>${esc(it.name)}</h3><button type="button" class="x" aria-label="关闭">×</button></div>
      <div class="meta">type: <span class="mono">${esc(it.type)}</span>${it.variant ? ` · variant: <span class="mono">${esc(it.variant)}</span>` : ""}</div>
      <div class="meta">默认尺寸 ${cm(it.size[0])}×${cm(it.size[1])}×${cm(it.size[2])} cm（宽×深×高）</div>`;
    info.hidden = false;
  },
  onViews: (views, current) => {
    $("#views").innerHTML = views.filter(v => v.orbit).map(v => `<button type="button" class="chip" data-view="${v.key}" aria-pressed="${v.key === current}">${v.name}</button>`).join("");
  },
});
info.addEventListener("click", e => { if ((e.target as HTMLElement).closest(".x")) { viewer.highlight(null); info.hidden = true; } });
$("#views").addEventListener("click", e => { const b = (e.target as HTMLElement).closest<HTMLElement>("[data-view]"); if (b) viewer.setView(b.dataset.view!); });
viewer.load(house);
viewer.setView("overview", true);
if (import.meta.env.DEV) (window as unknown as { viewer: Viewer }).viewer = viewer;
