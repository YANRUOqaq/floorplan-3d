/**
 * 大模型返回的“修改指令”：格式定义、套用到方案上、摆放检查。
 *
 * 为什么不让大模型直接返回整份 house.json：一是太长，二是它会顺手改坏墙和房间。
 * 指令只能增删改家具、换材质和风格、加清单项，墙和门窗动不了。
 *
 * 摆放：大模型很难算准坐标，所以除了直接给 pos，还可以用 place 说“靠哪面墙、在墙的哪一段”，
 * 由程序按房间外框和墙厚算出坐标和朝向。
 */
import { z } from "zod";
import { CATALOG_BY_TYPE, FURNITURE_TYPES } from "./catalog";
import { FLOOR_FINISHES, THEME_IDS, WALL_FINISHES, WOOD_FINISHES, parseHouse, type House, type Item, type Room, type Vec2 } from "./schema";
import { bbox, convexOverlap, distToSegment, itemFootprint, pointInPolygon, wallFrame, wallPoint } from "./geometry";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Num = z.number().finite();
const Size = z.tuple([Num.positive(), Num.positive(), Num.positive()]);

export const Place = z.object({
  room: z.string(),
  /** 靠房间的哪一边：N 北（上）、S 南（下）、W 西（左）、E 东（右） */
  wall: z.enum(["N", "S", "W", "E"]),
  /** 沿这面墙的位置：0 是西端或北端，1 是东端或南端，0.5 居中 */
  at: Num.min(0).max(1).default(0.5),
  /** 离墙的距离（米），默认 0 */
  gap: Num.min(0).max(3).default(0),
});
export type Place = z.infer<typeof Place>;

const ItemFields = {
  name: z.string().min(1).max(60).optional(),
  spec: z.string().max(120).optional(),
  size: Size.optional(),
  rot: Num.optional(),
  elevation: Num.min(0).max(3).optional(),
  variant: z.string().optional(),
  finish: z.enum(WOOD_FINISHES).optional(),
  color: Hex.optional(),
  price: Num.min(0).optional(),
  optional: z.boolean().optional(),
  note: z.string().max(200).optional(),
};

export const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), type: z.enum(FURNITURE_TYPES), room: z.string(), pos: z.tuple([Num, Num]).optional(), place: Place.omit({ room: true }).optional(), ...ItemFields, name: z.string().min(1).max(60) }),
  z.object({ op: z.literal("move"), id: z.string(), pos: z.tuple([Num, Num]).optional(), place: Place.optional(), rot: Num.optional() }),
  z.object({ op: z.literal("update"), id: z.string(), ...ItemFields }),
  z.object({ op: z.literal("remove"), id: z.string() }),
  z.object({ op: z.literal("setRoomFinish"), room: z.string(), floor: z.enum(FLOOR_FINISHES).optional(), floorColor: Hex.optional(), wall: z.enum(WALL_FINISHES).optional(), wallColor: Hex.optional() }),
  z.object({ op: z.literal("setTheme"), theme: z.enum(THEME_IDS) }),
  z.object({ op: z.literal("addExtra"), name: z.string().min(1).max(60), price: Num.min(0), spec: z.string().max(120).optional(), room: z.string().optional(), optional: z.boolean().optional(), note: z.string().max(200).optional() }),
  z.object({ op: z.literal("removeExtra"), id: z.string() }),
]);
export type Op = z.infer<typeof Op>;

export const LlmReply = z.object({
  /** 给用户看的说明 */
  reply: z.string(),
  ops: z.array(Op).max(80).default([]),
});
export type LlmReply = z.infer<typeof LlmReply>;

/* ---------- 摆放 ---------- */
/** 房间某一边的墙，内表面离墙中线有多远（墙厚的一半） */
function wallInset(h: House, room: Room, side: Place["wall"]): number {
  const b = bbox(room.polygon);
  const line: [Vec2, Vec2] = side === "N" ? [[b.x0, b.z0], [b.x1, b.z0]] : side === "S" ? [[b.x0, b.z1], [b.x1, b.z1]]
    : side === "W" ? [[b.x0, b.z0], [b.x0, b.z1]] : [[b.x1, b.z0], [b.x1, b.z1]];
  const mid: Vec2 = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
  let t = 0;
  for (const w of h.walls) if (distToSegment(mid, w.a, w.b) < 0.05 || distToSegment(line[0], w.a, w.b) < 0.05 && distToSegment(line[1], w.a, w.b) < 0.05) t = Math.max(t, w.thickness / 2);
  return t || 0.1;
}

/** 按“靠哪面墙、在哪一段”算出家具的中心和朝向：背面贴墙，正面朝屋里 */
export function resolvePlace(h: House, p: Place, size: [number, number, number]): { pos: Vec2; rot: number } {
  const room = h.rooms.find(r => r.id === p.room);
  if (!room) throw new Error(`房间 ${p.room} 不存在`);
  const b = bbox(room.polygon), [w, d] = size, inset = wallInset(h, room, p.wall);
  const lerp = (a0: number, a1: number) => {
    const lo = a0 + w / 2, hi = a1 - w / 2;
    return hi < lo ? (a0 + a1) / 2 : lo + (hi - lo) * p.at;
  };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  // 沿墙方向两端也要让开侧墙
  const insW = wallInset(h, room, "W"), insE = wallInset(h, room, "E"), insN = wallInset(h, room, "N"), insS = wallInset(h, room, "S");
  switch (p.wall) {
    case "N": return { pos: [r2(lerp(b.x0 + insW, b.x1 - insE)), r2(b.z0 + inset + p.gap + d / 2)], rot: 0 };
    case "S": return { pos: [r2(lerp(b.x0 + insW, b.x1 - insE)), r2(b.z1 - inset - p.gap - d / 2)], rot: 180 };
    case "W": return { pos: [r2(b.x0 + inset + p.gap + d / 2), r2(lerp(b.z0 + insN, b.z1 - insS))], rot: 90 };
    case "E": return { pos: [r2(b.x1 - inset - p.gap - d / 2), r2(lerp(b.z0 + insN, b.z1 - insS))], rot: -90 };
  }
}

/* ---------- 套用指令 ---------- */
export interface ApplyResult {
  house: House;
  /** 每条指令一句中文说明（给用户确认用） */
  lines: string[];
  /** 套不上的指令（id 不存在、动了原有设施等），这些指令被跳过 */
  errors: string[];
  /** 摆放问题（出房间、重叠、挡门），指令照样套用，由用户决定 */
  warnings: string[];
  /** 新增或移动过的家具 */
  touched: string[];
}

const name = (it: Pick<Item, "name" | "type">) => it.name || CATALOG_BY_TYPE[it.type]?.nameZh || it.type;
function newId(h: House, prefix: string) {
  const taken = new Set([...h.walls.flatMap(w => [w.id, ...w.openings.map(o => o.id)]), ...h.rooms.map(r => r.id), ...h.furniture.map(f => f.id), ...h.extras.map(e => e.id)]);
  for (let i = 1; ; i++) if (!taken.has(prefix + i)) return prefix + i;
}

export function applyOps(house: House, ops: Op[]): ApplyResult {
  const d = structuredClone(house);
  const lines: string[] = [], errors: string[] = [], touched: string[] = [];
  const roomName = (id?: string) => d.rooms.find(r => r.id === id)?.name ?? id ?? "";
  const editable = (id: string) => {
    const it = d.furniture.find(f => f.id === id);
    if (!it) { errors.push(`找不到家具 ${id}，跳过`); return null; }
    if (it.fixed) { errors.push(`${name(it)} 是房子原有的设施，不能改动，跳过`); return null; }
    return it;
  };
  for (const op of ops) {
    try {
      switch (op.op) {
        case "add": {
          const cat = CATALOG_BY_TYPE[op.type];
          if (!d.rooms.some(r => r.id === op.room)) { errors.push(`房间 ${op.room} 不存在，没加 ${op.name}`); break; }
          const size = (op.size ?? [...cat.defaultSize]) as [number, number, number];
          let pos: Vec2, rot = op.rot ?? 0;
          if (op.place) ({ pos, rot } = resolvePlace(d, { ...op.place, room: op.room }, size));
          else if (op.pos) pos = op.pos;
          else { errors.push(`${op.name} 没给位置，跳过`); break; }
          if (op.rot != null) rot = op.rot;
          const it: Item = { id: newId(d, "ai"), type: op.type, name: op.name, room: op.room, pos, rot, size };
          for (const k of ["spec", "elevation", "variant", "finish", "color", "optional", "note"] as const) if (op[k] != null) (it as Record<string, unknown>)[k] = op[k];
          if (op.price != null) { it.price = op.price; it.priceBasis = "llm"; }
          if (cat.variants && it.variant && !cat.variants.includes(it.variant)) delete it.variant;
          d.furniture.push(it); touched.push(it.id);
          lines.push(`在${roomName(op.room)}加 ${op.name}（${Math.round(size[0] * 100)}×${Math.round(size[1] * 100)} cm${op.price != null ? `，约 ¥${op.price}` : ""}）`);
          break;
        }
        case "move": {
          const it = editable(op.id); if (!it) break;
          if (op.place) { const r = resolvePlace(d, op.place, it.size); it.pos = r.pos; it.rot = r.rot; it.room = op.place.room; }
          else if (op.pos) it.pos = op.pos;
          if (op.rot != null) it.rot = op.rot;
          if (!op.place) it.room = d.rooms.find(r => pointInPolygon(it.pos, r.polygon))?.id ?? it.room;
          touched.push(it.id);
          lines.push(`把 ${name(it)} 移到${roomName(it.room)}${op.place ? `靠${({ N: "北", S: "南", W: "西", E: "东" })[op.place.wall]}墙` : ""}`);
          break;
        }
        case "update": {
          const it = editable(op.id); if (!it) break;
          const changed: string[] = [];
          for (const k of ["name", "spec", "size", "rot", "elevation", "variant", "finish", "color", "optional", "note"] as const) {
            if (op[k] == null) continue;
            (it as Record<string, unknown>)[k] = op[k]; changed.push(k);
          }
          if (op.price != null) { it.price = op.price; it.priceBasis = "llm"; changed.push("price"); }
          if (changed.includes("size") || changed.includes("rot")) touched.push(it.id);
          lines.push(`改 ${name(it)}：${changed.map(k => FIELD_LABEL[k] ?? k).join("、")}`);
          break;
        }
        case "remove": {
          const it = editable(op.id); if (!it) break;
          d.furniture = d.furniture.filter(f => f.id !== op.id);
          lines.push(`删掉 ${name(it)}`);
          break;
        }
        case "setRoomFinish": {
          const r = d.rooms.find(r => r.id === op.room);
          if (!r) { errors.push(`房间 ${op.room} 不存在，跳过`); break; }
          if (op.floor) r.floor = op.floor;
          if (op.floorColor) r.floorColor = op.floorColor;
          if (op.wall) r.wall = op.wall;
          if (op.wallColor) r.wallColor = op.wallColor;
          lines.push(`${r.name}：${[op.floor && "地面", op.floorColor && "地板颜色", op.wall && "墙面", op.wallColor && "墙面颜色"].filter(Boolean).join("、")}`);
          break;
        }
        case "setTheme": d.theme = op.theme; lines.push(`整体风格换成 ${op.theme}`); break;
        case "addExtra": {
          if (op.room && !d.rooms.some(r => r.id === op.room)) { errors.push(`房间 ${op.room} 不存在，没加 ${op.name}`); break; }
          const e = { id: newId(d, "x"), name: op.name, price: op.price, priceBasis: "llm" as const, ...(op.spec ? { spec: op.spec } : {}), ...(op.room ? { room: op.room } : {}), ...(op.optional ? { optional: true } : {}), ...(op.note ? { note: op.note } : {}) };
          d.extras.push(e);
          lines.push(`清单加一项：${op.name}，约 ¥${op.price}`);
          break;
        }
        case "removeExtra": {
          const e = d.extras.find(x => x.id === op.id);
          if (!e) { errors.push(`找不到清单项 ${op.id}，跳过`); break; }
          d.extras = d.extras.filter(x => x.id !== op.id);
          lines.push(`清单删掉：${e.name}`);
          break;
        }
      }
    } catch (err) { errors.push((err as Error).message); }
  }
  const out = parseHouse(d);   // 最后整体校验一遍，格式不对直接抛错
  return { house: out, lines, errors, warnings: checkPlacement(out, touched), touched };
}
const FIELD_LABEL: Record<string, string> = { name: "名称", spec: "规格", size: "尺寸", rot: "朝向", elevation: "离地高度", variant: "样式", finish: "木色", color: "颜色", optional: "是否可选", note: "备注", price: "价格" };

/* ---------- 摆放检查 ---------- */
/** 叠放、贴地、挂高的东西不参与重叠检查 */
const NO_OVERLAP = new Set(["rug", "deck_tiles", "curtain", "pendant_lamp", "table_lamp", "tv", "monitor", "stove"]);
/** 椅子可以推进桌子底下 */
const TUCK = new Set(["chair", "stool", "office_chair"]);
const TABLES = new Set(["dining_table", "desk", "coffee_table"]);

export function checkPlacement(h: House, ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const it = h.furniture.find(f => f.id === id); if (!it) continue;
    const fp = itemFootprint(it), nm = name(it);
    const room = h.rooms.find(r => r.id === it.room);
    const shrink = fp.map(p => [p[0] + (it.pos[0] - p[0]) * 0.02, p[1] + (it.pos[1] - p[1]) * 0.02] as Vec2);
    if (!room) out.push(`${nm} 不在任何房间里`);
    else if (!shrink.every(p => h.rooms.some(r => pointInPolygon(p, r.polygon)))) out.push(`${nm} 超出了${room.name}`);
    // 穿墙：占地和墙体相交
    for (const w of h.walls) {
      const { n } = wallFrame(w), t = w.thickness / 2 - 0.01;
      if (t <= 0) continue;
      const wp: Vec2[] = [[w.a[0] + n[0] * t, w.a[1] + n[1] * t], [w.b[0] + n[0] * t, w.b[1] + n[1] * t], [w.b[0] - n[0] * t, w.b[1] - n[1] * t], [w.a[0] - n[0] * t, w.a[1] - n[1] * t]];
      if (convexOverlap(fp, wp, 0.01) && !NO_OVERLAP.has(it.type)) { out.push(`${nm} 嵌进墙里了`); break; }
    }
    if (NO_OVERLAP.has(it.type) || it.elevation) continue;
    for (const o of h.furniture) {
      if (o.id === it.id || NO_OVERLAP.has(o.type) || o.elevation) continue;
      if ((TUCK.has(it.type) && TABLES.has(o.type)) || (TUCK.has(o.type) && TABLES.has(it.type))) continue;
      if (convexOverlap(fp, itemFootprint(o), 0.02)) out.push(`${nm} 和 ${name(o)} 重叠`);
    }
    // 挡门：平开门开门扫过的范围（近似成正方形）
    for (const w of h.walls) for (const o of w.openings) {
      if (o.type !== "door" && o.type !== "opening" && o.type !== "sliding") continue;
      const side = o.side ?? 1, t = w.thickness / 2;
      const sides = o.type === "door" ? [side] : [1, -1];
      for (const sg of sides) {
        const reach = o.type === "door" ? o.width : 0.5;
        const sq: Vec2[] = [wallPoint(w, o.offset, sg * t), wallPoint(w, o.offset + o.width, sg * t), wallPoint(w, o.offset + o.width, sg * (t + reach)), wallPoint(w, o.offset, sg * (t + reach))];
        if (convexOverlap(fp, sq, 0.03)) { out.push(`${nm} 挡住了门口`); break; }
      }
    }
  }
  return [...new Set(out)];
}
