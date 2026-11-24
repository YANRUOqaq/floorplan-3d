/**
 * 选中项的属性表单：墙、门窗、房间、家具。每个字段写成 { 读, 写 } 一对函数，
 * 表单改动时用 store.commit() 提交，所以都能撤销。长度在表单里用厘米（坐标用米），存的时候换回米。
 */
import type { House, Item, Opening, Room, Wall } from "../model/schema";
import { FLOOR_FINISHES, FLOOR_LABEL, OPENING_LABEL, OPENING_TYPES, ROOM_LABEL, ROOM_TYPES, WALL_FINISHES, WALL_LABEL, WOOD_FINISHES, WOOD_LABEL } from "../model/schema";
import { CATALOG, CATALOG_BY_TYPE } from "../model/catalog";
import { polygonArea, roomAt, wallFrame } from "../model/geometry";
import { THEMES } from "../three/materials";
import { deleteById, roomDefaults } from "../editor/editor";
import type { App } from "./app";
import { esc, toast } from "./dom";

type Kind = "text" | "num" | "select" | "check" | "color" | "textarea";
interface Field {
  label: string; kind: Kind; unit?: string; step?: number; options?: [string, string][]; wide?: boolean; hint?: string;
  get(h: House): unknown;
  set(d: House, v: unknown): void;
  /** 颜色字段没设置时显示的默认色 */
  fallback?: (h: House) => string;
}

const cm = (m: number | undefined) => m == null ? "" : String(Math.round(m * 1000) / 10);
const fromCm = (v: unknown) => Math.round(Number(v) * 10) / 1000;
const m2 = (m: number) => String(Math.round(m * 1000) / 1000);

function wallFields(id: string): Field[] {
  const W = (h: House) => h.walls.find(w => w.id === id)!;
  return [
    { label: "长度", kind: "num", unit: "mm", step: 10, get: h => Math.round(wallFrame(W(h)).len * 1000), set: (d, v) => { const w = W(d), { d: dir } = wallFrame(w), L = Number(v) / 1000; if (!(L > 0.05)) throw new Error("长度要大于 5 cm"); w.b = [r3(w.a[0] + dir[0] * L), r3(w.a[1] + dir[1] * L)]; }, hint: "改长度时起点不动，终点沿墙的方向移动" },
    { label: "墙厚", kind: "num", unit: "cm", step: 1, get: h => cm(W(h).thickness), set: (d, v) => { W(d).thickness = fromCm(v); } },
    { label: "高度", kind: "num", unit: "cm", step: 1, get: h => cm(W(h).height), set: (d, v) => { const w = W(d); if (v === "" || v == null) delete w.height; else w.height = fromCm(v); }, hint: "空着就是层高" },
    { label: "类型", kind: "select", options: [["wall", "墙"], ["parapet", "矮墙"], ["railing", "栏板（下实上空）"]], get: h => W(h).kind, set: (d, v) => { W(d).kind = v as Wall["kind"]; } },
    { label: "起点 x", kind: "num", unit: "m", step: 0.01, get: h => m2(W(h).a[0]), set: (d, v) => { W(d).a[0] = Number(v); } },
    { label: "起点 z", kind: "num", unit: "m", step: 0.01, get: h => m2(W(h).a[1]), set: (d, v) => { W(d).a[1] = Number(v); } },
    { label: "终点 x", kind: "num", unit: "m", step: 0.01, get: h => m2(W(h).b[0]), set: (d, v) => { W(d).b[0] = Number(v); } },
    { label: "终点 z", kind: "num", unit: "m", step: 0.01, get: h => m2(W(h).b[1]), set: (d, v) => { W(d).b[1] = Number(v); } },
  ];
}

function openingFields(id: string, o: Opening): Field[] {
  const O = (h: House) => { for (const w of h.walls) { const x = w.openings.find(o => o.id === id); if (x) return x; } throw new Error("找不到门窗"); };
  const f: Field[] = [
    { label: "类型", kind: "select", options: OPENING_TYPES.map(t => [t, OPENING_LABEL[t]]), get: h => O(h).type, set: (d, v) => { const x = O(d); x.type = v as Opening["type"]; if ((v === "door" || v === "entry") && !x.hinge) { x.hinge = "a"; x.side = 1; } if (v === "sliding" && !x.panels) x.panels = 2; } },
    { label: "距墙起点", kind: "num", unit: "cm", step: 1, get: h => cm(O(h).offset), set: (d, v) => { O(d).offset = fromCm(v); } },
    { label: "宽", kind: "num", unit: "cm", step: 1, get: h => cm(O(h).width), set: (d, v) => { O(d).width = fromCm(v); } },
    { label: "下沿离地", kind: "num", unit: "cm", step: 1, get: h => cm(O(h).bottom), set: (d, v) => { O(d).bottom = fromCm(v); } },
    { label: "上沿离地", kind: "num", unit: "cm", step: 1, get: h => cm(O(h).top), set: (d, v) => { O(d).top = fromCm(v); } },
  ];
  if (o.type === "door" || o.type === "entry") f.push(
    { label: "门轴", kind: "select", options: [["a", "靠墙起点一端"], ["b", "靠墙终点一端"]], get: h => O(h).hinge ?? "a", set: (d, v) => { O(d).hinge = v as "a" | "b"; } },
    { label: "往哪边开", kind: "select", options: [["1", "沿墙方向的左手边"], ["-1", "沿墙方向的右手边"]], get: h => String(O(h).side ?? 1), set: (d, v) => { O(d).side = Number(v) as 1 | -1; } },
  );
  if (o.type === "sliding") f.push({ label: "扇数", kind: "num", step: 1, get: h => O(h).panels ?? 2, set: (d, v) => { O(d).panels = Math.max(1, Math.min(6, Math.round(Number(v)))); } });
  if (o.type === "window") f.push({ label: "室内护栏", kind: "check", get: h => !!O(h).rail, set: (d, v) => { if (v) O(d).rail = true; else delete O(d).rail; } });
  return f;
}

function roomFields(id: string, r: Room): Field[] {
  const R = (h: House) => h.rooms.find(r => r.id === id)!;
  const f: Field[] = [
    { label: "名称", kind: "text", wide: true, get: h => R(h).name, set: (d, v) => { const s = String(v).trim(); if (!s) throw new Error("名称不能空"); R(d).name = s; } },
    { label: "类型", kind: "select", options: ROOM_TYPES.map(t => [t, ROOM_LABEL[t]]), get: h => R(h).type, set: (d, v) => { const x = R(d); x.type = v as Room["type"]; const def = roomDefaults(x.type); x.floor = def.floor; x.wall = def.wall; if (def.outdoor) x.outdoor = true; else delete x.outdoor; }, hint: "改类型会把地面和墙面换成这类房间的默认做法" },
    { label: "地面", kind: "select", options: FLOOR_FINISHES.map(t => [t, FLOOR_LABEL[t]]), get: h => R(h).floor, set: (d, v) => { R(d).floor = v as Room["floor"]; } },
    { label: "墙面", kind: "select", options: WALL_FINISHES.map(t => [t, WALL_LABEL[t]]), get: h => R(h).wall, set: (d, v) => { R(d).wall = v as Room["wall"]; } },
  ];
  if (r.floor === "wood") f.push({ label: "地板颜色", kind: "color", get: h => R(h).floorColor, set: (d, v) => { if (v) R(d).floorColor = String(v); else delete R(d).floorColor; }, fallback: h => THEMES[h.theme].floorColor });
  if (r.wall === "paint") f.push({ label: "墙面颜色", kind: "color", get: h => R(h).wallColor, set: (d, v) => { if (v) R(d).wallColor = String(v); else delete R(d).wallColor; }, fallback: h => THEMES[h.theme].wallColor });
  f.push({ label: "室外（阳台）", kind: "check", get: h => !!R(h).outdoor, set: (d, v) => { if (v) R(d).outdoor = true; else delete R(d).outdoor; } });
  return f;
}

function itemFields(id: string, it: Item): Field[] {
  const I = (h: House) => h.furniture.find(f => f.id === id)!;
  const cat = CATALOG_BY_TYPE[it.type];
  const f: Field[] = [
    { label: "名称", kind: "text", wide: true, get: h => I(h).name ?? "", set: (d, v) => { const s = String(v).trim(); if (s) I(d).name = s; else delete I(d).name; } },
    { label: "家具类型", kind: "select", wide: true, options: CATALOG.map(c => [c.type, `${c.category} · ${c.nameZh}`]), get: h => I(h).type, set: (d, v) => { const x = I(d), c = CATALOG_BY_TYPE[String(v)]; x.type = c.type; x.size = [...c.defaultSize]; delete x.variant; }, hint: "换类型会把尺寸换成新类型的默认尺寸" },
    { label: "宽", kind: "num", unit: "cm", step: 1, get: h => cm(I(h).size[0]), set: (d, v) => { I(d).size[0] = fromCm(v); } },
    { label: "深", kind: "num", unit: "cm", step: 1, get: h => cm(I(h).size[1]), set: (d, v) => { I(d).size[1] = fromCm(v); } },
    { label: "高", kind: "num", unit: "cm", step: 1, get: h => cm(I(h).size[2]), set: (d, v) => { I(d).size[2] = fromCm(v); } },
    { label: "朝向", kind: "select", options: [["0", "正面朝南（下）"], ["90", "正面朝东（右）"], ["180", "正面朝北（上）"], ["-90", "正面朝西（左）"]], get: h => String(I(h).rot), set: (d, v) => { I(d).rot = Number(v); } },
    { label: "中心 x", kind: "num", unit: "m", step: 0.01, get: h => m2(I(h).pos[0]), set: (d, v) => { const x = I(d); x.pos[0] = Number(v); x.room = roomAt(d.rooms, x.pos)?.id; } },
    { label: "中心 z", kind: "num", unit: "m", step: 0.01, get: h => m2(I(h).pos[1]), set: (d, v) => { const x = I(d); x.pos[1] = Number(v); x.room = roomAt(d.rooms, x.pos)?.id; } },
    { label: "离地", kind: "num", unit: "cm", step: 1, get: h => cm(I(h).elevation), set: (d, v) => { if (v === "" || Number(v) === 0) delete I(d).elevation; else I(d).elevation = fromCm(v); }, hint: "台灯、电视放在别的家具上时填下面那件的高度" },
  ];
  if (cat?.variants) f.push({ label: "样式", kind: "select", options: cat.variants.map(v => [v, v]), get: h => I(h).variant ?? cat.variants![0], set: (d, v) => { I(d).variant = String(v); } });
  f.push(
    { label: "木色/柜体", kind: "select", options: [["", "跟随风格"], ...WOOD_FINISHES.map(w => [w, WOOD_LABEL[w]] as [string, string])], get: h => I(h).finish ?? "", set: (d, v) => { if (v) I(d).finish = v as Item["finish"]; else delete I(d).finish; } },
    { label: "布艺颜色", kind: "color", get: h => I(h).color, set: (d, v) => { if (v) I(d).color = String(v); else delete I(d).color; }, fallback: h => THEMES[h.theme].fabric },
    { label: "规格说明", kind: "text", wide: true, get: h => I(h).spec ?? "", set: (d, v) => { const s = String(v).trim(); if (s) I(d).spec = s; else delete I(d).spec; } },
    { label: "价格", kind: "num", unit: "元", step: 1, get: h => I(h).price ?? "", set: (d, v) => { const x = I(d); if (v === "" || v == null) { delete x.price; delete x.priceBasis; } else { x.price = Math.max(0, Number(v)); x.priceBasis = "user"; } }, hint: "改了价格就算自填；空着表示不计入预算" },
    { label: "可选（不算必买）", kind: "check", get: h => !!I(h).optional, set: (d, v) => { if (v) I(d).optional = true; else delete I(d).optional; } },
    { label: "房子原有的设施", kind: "check", get: h => !!I(h).fixed, set: (d, v) => { if (v) I(d).fixed = true; else delete I(d).fixed; }, hint: "勾上后不计预算，大模型也不会动它" },
    { label: "备注", kind: "textarea", wide: true, get: h => I(h).note ?? "", set: (d, v) => { const s = String(v).trim(); if (s) I(d).note = s; else delete I(d).note; } },
  );
  return f;
}

function fieldHtml(f: Field, i: number, h: House): string {
  const v = f.get(h), id = `pf-${i}`;
  const lab = `<span>${esc(f.label)}${f.unit ? `（${f.unit}）` : ""}</span>`;
  const hint = f.hint ? ` title="${esc(f.hint)}"` : "";
  let ctl = "";
  if (f.kind === "select") ctl = `<select id="${id}" data-k="${i}">${f.options!.map(([k, t]) => `<option value="${esc(k)}"${String(v) === k ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  else if (f.kind === "check") return `<label class="check${f.wide ? " wide" : ""}"${hint}><input type="checkbox" id="${id}" data-k="${i}"${v ? " checked" : ""}> ${esc(f.label)}</label>`;
  else if (f.kind === "textarea") ctl = `<textarea id="${id}" data-k="${i}" rows="2">${esc(v)}</textarea>`;
  else if (f.kind === "color") {
    const cur = (v as string | undefined) ?? f.fallback!(h);
    ctl = `<span class="row"><input type="color" id="${id}" data-k="${i}" value="${esc(cur)}"><span class="muted mono">${v ? esc(v) : "跟随风格"}</span>${v ? `<button type="button" class="btn small" data-clear="${i}">跟随风格</button>` : ""}</span>`;
  } else ctl = `<input type="${f.kind === "num" ? "number" : "text"}" id="${id}" data-k="${i}" value="${esc(v)}"${f.step ? ` step="${f.step}"` : ""}>`;
  return `<label class="field${f.wide ? " wide" : ""}"${hint}>${lab}${ctl}</label>`;
}

/** 在 box 里画出当前选中项的表单；没有选中时清空并返回 false */
export function renderProps(app: App, box: HTMLElement): boolean {
  const h = app.store.house, id = app.selected;
  let title = "", fields: Field[] = [], extra = "";
  const wall = h.walls.find(w => w.id === id);
  const opening = h.walls.flatMap(w => w.openings).find(o => o.id === id);
  const room = h.rooms.find(r => r.id === id);
  const item = h.furniture.find(f => f.id === id);
  if (wall) { title = "墙"; fields = wallFields(wall.id); extra = `<p class="note">墙上有 ${wall.openings.length} 个门窗。删除墙会连门窗一起删。</p>`; }
  else if (opening) { title = OPENING_LABEL[opening.type]; fields = openingFields(opening.id, opening); }
  else if (room) { title = "房间"; fields = roomFields(room.id, room); extra = `<p class="note">面积 ${polygonArea(room.polygon).toFixed(2)}㎡（按墙中线算）。拖动顶点可以改形状。</p>`; }
  else if (item) { title = CATALOG_BY_TYPE[item.type]?.nameZh ?? "家具"; fields = itemFields(item.id, item); }
  else { box.innerHTML = ""; box.hidden = true; return false; }
  box.hidden = false;
  box.innerHTML = `<div class="props-head"><h3>选中：${esc(title)} <span class="muted mono">${esc(id)}</span></h3>
      <span class="row">${item ? '<button type="button" class="btn small" data-act="locate">在 3D 里看</button>' : ""}<button type="button" class="btn small danger" data-act="delete">删除</button><button type="button" class="btn small" data-act="close" aria-label="取消选中">×</button></span></div>
    <div class="props-grid">${fields.map((f, i) => fieldHtml(f, i, h)).join("")}</div>${extra}`;
  const commit = (f: Field, v: unknown) => {
    try { app.store.commit(`改${f.label}`, d => f.set(d, v)); }
    catch (err) { toast((err as Error).message, true); renderProps(app, box); }
  };
  box.onchange = e => {
    const el = e.target as HTMLInputElement, k = el.dataset.k; if (k == null) return;
    const f = fields[+k];
    commit(f, f.kind === "check" ? el.checked : el.value);
  };
  box.onclick = e => {
    const t = e.target as HTMLElement;
    const c = t.closest<HTMLElement>("[data-clear]")?.dataset.clear; if (c != null) commit(fields[+c], undefined);
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "delete") deleteById(app, id!);
    if (act === "close") app.select(null);
    if (act === "locate") { app.showTab("3d"); app.viewer.locate(id!); }
  };
  return true;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
