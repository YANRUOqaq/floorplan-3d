/**
 * 大模型返回的“修改指令”：格式定义、套用到方案上、摆放检查。
 *
 * 为什么不让大模型直接返回整份 house.json：一是太长，二是它会顺手改坏墙和房间。
 * 指令只能增删改家具、换材质和风格、加清单项，墙和门窗动不了。
 *
 * 摆放：大模型很难算准坐标，所以除了直接给 pos，还可以用 place 说“靠哪面墙、在墙的哪一段”，
 * 或者“挨着哪件家具”“放在哪件家具上面”，由程序按房间外框、墙厚和那件家具的位置算出坐标和朝向。
 * 新加的家具还没有 id，大模型可以给它起个临时名字（ref），后面的指令用这个名字指代它。
 *
 * 画面质量不交给大模型：家具外形、材质、光照都由程序定，大模型只能选类型、木色、风格这些固定选项；
 * 它给的尺寸限制在每种家具的常见范围内（fitSize），颜色只能写色板里的名字（themes.ts）。
 * 这些限制只管大模型的指令，用户在属性面板里手动改不受限。
 */
import { z } from "zod";
import { CATALOG_BY_TYPE, FURNITURE_TYPES, cmText, rangeText } from "./catalog";
import { FLOOR_FINISHES, FLOOR_LABEL, THEME_IDS, WALL_FINISHES, WALL_LABEL, WOOD_FINISHES, WOOD_LABEL, parseHouse, type House, type Item, type Room, type Vec2 } from "./schema";
import { FABRIC_COLORS, FLOOR_COLORS, THEMES, WALL_COLORS, type Palette } from "./themes";
import { bbox, convexOverlap, distToSegment, itemFootprint, pointInPolygon, wallFrame, wallPoint } from "./geometry";

const Num = z.number().finite();
const Size = z.tuple([Num.positive(), Num.positive(), Num.positive()]);
type Size3 = [number, number, number];

/** 颜色只能写色板里的名字；给 null 是去掉单独设的颜色，跟随整体风格 */
function paletteName(p: Palette, what: string) {
  const names = Object.keys(p) as [string, ...string[]];
  return z.enum(names, { error: `${what}只能写色板里的名字（${names.join("、")}），不能写色值` }).nullable();
}

const Dir = z.enum(["N", "S", "W", "E"]);
type Dir = z.infer<typeof Dir>;

export const Place = z.object({
  room: z.string(),
  /** 靠房间的哪一边：N 北（上）、S 南（下）、W 西（左）、E 东（右） */
  wall: Dir,
  /** 沿这面墙的位置：0 是西端或北端，1 是东端或南端，0.5 居中 */
  at: Num.min(0).max(1).default(0.5),
  /** 离墙的距离（米），默认 0 */
  gap: Num.min(0).max(3).default(0),
});
export type Place = z.infer<typeof Place>;

/**
 * 挨着另一件家具（id 或本次新加家具的 ref）。side 是在它的哪个方向：
 * 在它左右两侧时背面和它对齐（床头柜挨着床）；在它正面那一侧时放在它前面（茶几在沙发前、椅子在书桌前）。
 */
export const Beside = z.object({ beside: z.string(), side: Dir, gap: Num.min(0).max(3).default(0) });
export type Beside = z.infer<typeof Beside>;
/** 放在另一件家具上面（台灯放床头柜上），高度由程序算 */
export const On = z.object({ on: z.string() });
export type On = z.infer<typeof On>;

const ItemFields = {
  name: z.string().min(1).max(60).optional(),
  spec: z.string().max(120).optional(),
  size: Size.optional(),
  rot: Num.optional(),
  elevation: Num.min(0).max(3).optional(),
  variant: z.string().optional(),
  finish: z.enum(WOOD_FINISHES).optional(),
  color: paletteName(FABRIC_COLORS, "布艺颜色 color ").optional(),
  price: Num.min(0).optional(),
  optional: z.boolean().optional(),
  note: z.string().max(200).optional(),
};

export const Op = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"), type: z.enum(FURNITURE_TYPES), room: z.string(),
    /** 自己起的临时名字，同一次回复里后面的指令可以用它指代这件家具（不写也有自动名字，见 RefTable） */
    ref: z.string().min(1).max(40).optional(),
    pos: z.tuple([Num, Num]).optional(), place: z.union([Place.omit({ room: true }), Beside, On], { error: 'place 只能是这三种之一：{"wall","at","gap"}、{"beside","side","gap"}、{"on"}。只给坐标时不要放进 place，直接在指令里写 pos 和 rot' }).optional(),
    // name 不写就用家具类型的中文名（2026-11-25 实测通义千问加台灯时会漏写，为这个多重试一轮不值得）
    ...ItemFields,
  }),
  z.object({ op: z.literal("move"), id: z.string(), pos: z.tuple([Num, Num]).optional(), place: z.union([Place.partial({ room: true }), Beside, On], { error: 'place 只能是这三种之一：{"wall","at","gap"}、{"beside","side","gap"}、{"on"}。只给坐标时不要放进 place，直接在指令里写 pos 和 rot' }).optional(), rot: Num.optional() }),
  z.object({ op: z.literal("update"), id: z.string(), ...ItemFields }),
  z.object({ op: z.literal("remove"), id: z.string() }),
  // 颜色给 null：去掉房间单独的颜色，跟随整体风格
  z.object({ op: z.literal("setRoomFinish"), room: z.string(), floor: z.enum(FLOOR_FINISHES).optional(), floorColor: paletteName(FLOOR_COLORS, "地板颜色 floorColor ").optional(), wall: z.enum(WALL_FINISHES).optional(), wallColor: paletteName(WALL_COLORS, "墙面颜色 wallColor ").optional() }),
  z.object({ op: z.literal("setTheme"), theme: z.enum(THEME_IDS) }),
  z.object({ op: z.literal("addExtra"), name: z.string().min(1).max(60), price: Num.min(0), spec: z.string().max(120).optional(), room: z.string().optional(), optional: z.boolean().optional(), note: z.string().max(200).optional() }),
  z.object({ op: z.literal("removeExtra"), id: z.string() }),
]);
export type Op = z.infer<typeof Op>;

/**
 * 校验前先把意思明确的写法改正过来，省一轮重试。2026-11-24 实测通义千问会把坐标写进 place：
 * {"place":{"pos":[x,z],"rot":0}}，意思就是 {"pos":[x,z],"rot":0}。
 */
function tidyOp(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const op = raw as Record<string, unknown>, p = op.place as Record<string, unknown> | undefined;
  if (p && typeof p === "object" && "pos" in p && !("wall" in p || "beside" in p || "on" in p)) {
    const { place: _, ...rest } = op;
    return { ...rest, pos: op.pos ?? p.pos, ...(op.rot ?? p.rot) != null ? { rot: op.rot ?? p.rot } : {} };
  }
  return raw;
}

export const LlmReply = z.object({
  /** 给用户看的说明 */
  reply: z.string(),
  ops: z.array(z.preprocess(tidyOp, Op)).max(80).default([]),
});
export type LlmReply = z.infer<typeof LlmReply>;

/* ---------- 尺寸 ---------- */
/**
 * 大模型给的尺寸限制在这种家具的常见范围内（catalog.ts 的 range），超出的那一维改到范围边上。
 * keep 是家具现在的尺寸：和现在一样的那一维不动（可能是用户手动设的），只管大模型这次真正改了的。
 */
export function fitSize(type: string, size: Size3, keep?: Size3): { size: Size3; note?: string } {
  const cat = CATALOG_BY_TYPE[type];
  const out = size.map((v, i) => keep && v === keep[i] ? v : Math.min(Math.max(v, cat.range[i][0]), cat.range[i][1])) as Size3;
  if (out.every((v, i) => v === size[i])) return { size: out };
  const cm = (s: number[]) => s.map(cmText).join("×");
  return { size: out, note: `尺寸超出${cat.nameZh}的常见范围（${rangeText(cat)}），从 ${cm(size)} 改成 ${cm(out)} cm` };
}

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

const DIR_VEC: Record<Dir, Vec2> = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
const DIR_ZH: Record<Dir, string> = { N: "北", S: "南", W: "西", E: "东" };
/** 坐的东西放在桌子前面时转过来面朝桌子 */
const SEATS = new Set(["chair", "stool", "office_chair"]);
const normRot = (r: number) => { const v = ((r % 360) + 540) % 360 - 180; return v === -180 ? 180 : v; };

/** 相对另一件家具摆放：算出中心、朝向，放在上面时还有离地高度 */
export function resolveRelative(ref: Item, p: Beside | On, type: string, size: [number, number, number]): { pos: Vec2; rot: number; elevation?: number } {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  if ("on" in p) return { pos: [ref.pos[0], ref.pos[1]], rot: ref.rot, elevation: r2((ref.elevation ?? 0) + ref.size[2]) };
  const a = ref.rot * Math.PI / 180;
  const f: Vec2 = [Math.sin(a), Math.cos(a)];     // 正面朝向：rot 0 朝南（+z），90 朝东（+x）
  const l: Vec2 = [Math.cos(a), -Math.sin(a)];    // 和正面垂直的方向
  const c = DIR_VEC[p.side], along = c[0] * l[0] + c[1] * l[1], front = c[0] * f[0] + c[1] * f[1];
  const [w, d] = size, [rw, rd] = ref.size;
  if (Math.abs(along) > 0.7) {
    // 并排：背面和它对齐，贴着它的侧面
    const s = Math.sign(along), off = rw / 2 + p.gap + w / 2;
    const back: Vec2 = [ref.pos[0] - f[0] * rd / 2, ref.pos[1] - f[1] * rd / 2];
    return { pos: [r2(back[0] + f[0] * d / 2 + l[0] * s * off), r2(back[1] + f[1] * d / 2 + l[1] * s * off)], rot: ref.rot };
  }
  if (front > 0.7) {
    const off = rd / 2 + p.gap + d / 2;
    return { pos: [r2(ref.pos[0] + f[0] * off), r2(ref.pos[1] + f[1] * off)], rot: SEATS.has(type) ? normRot(ref.rot + 180) : ref.rot };
  }
  throw new Error(`${name(ref)} 的${DIR_ZH[p.side]}边是它的背面，放不了东西`);
}

/* ---------- 引用 ---------- */
/** beside / on 引用的名字。大模型有时会写成 "ref:bed1"，意思明确，去掉前缀 */
export const refKey = (p: Beside | On) => ("on" in p ? p.on : p.beside).replace(/^ref:/, "");

/**
 * 一次回复里怎么指代家具：
 * 1. add 里自己写的 ref；
 * 2. 已有家具的 id；
 * 3. 这次新加的家具的自动名字“类型+序号”：这次第一张床是 bed1，第二个床头柜是 nightstand2。
 *    2026-11-24 实测通义千问不写 ref 时会自己这样叫，所以定成规则。
 * 自动名字和已有家具的 id 撞了（2D 编辑器画的床 id 也是 bed1）就分不清，当作问题报出来，不猜。
 */
export class RefTable {
  private explicit = new Map<string, string>();
  private implicit = new Map<string, string>();
  private counts = new Map<string, number>();
  constructor(private existing: Set<string>) {}
  /** 每条 add 都要登记（套用失败的也要，序号才和大模型数的一致）；id 为空表示没加成 */
  add(type: string, ref: string | undefined, id: string | null) {
    const n = (this.counts.get(type) ?? 0) + 1;
    this.counts.set(type, n);
    if (id) { this.implicit.set(type + n, id); if (ref) this.explicit.set(ref.replace(/^ref:/, ""), id); }
  }
  resolve(key: string): { id: string } | { problem: string } {
    const e = this.explicit.get(key);
    if (e) return { id: e };
    const old = this.existing.has(key), neu = this.implicit.get(key);
    if (old && neu) return { problem: `${key} 既是已有家具的 id，又是这次新加的家具的自动名字，分不清` };
    if (old) return { id: key };
    if (neu) return { id: neu };
    return { problem: `找不到 ${key}` };
  }
}

/**
 * 套用前检查 beside / on 的引用，返回问题（找不到、分不清）。
 * 对话流程用它把问题发回给大模型改一次（见 llm/agent.ts）。
 */
export function refProblems(h: House, ops: Op[]): string[] {
  const t = new RefTable(new Set(h.furniture.map(f => f.id))), out: string[] = [];
  ops.forEach((op, i) => {
    if ((op.op === "add" || op.op === "move") && op.place && !("wall" in op.place)) {
      const r = t.resolve(refKey(op.place));
      if ("problem" in r) out.push(`第 ${i + 1} 条指令：${r.problem}`);
    }
    if (op.op === "add") t.add(op.type, op.ref, `new${i}`);
  });
  return out;
}

/* ---------- 套用指令 ---------- */
export interface ApplyResult {
  house: House;
  /** 每条指令一句中文说明（给用户确认用） */
  lines: string[];
  /** 套不上的指令（id 不存在、动了原有设施等），这些指令被跳过 */
  errors: string[];
  /** 要留意的问题（尺寸被改到常见范围内、出房间、重叠、挡门、清单项可能重复），指令照样套用，由用户决定 */
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
  const lines: string[] = [], errors: string[] = [], touched: string[] = [], addedExtras: string[] = [], sizeNotes: string[] = [];
  const roomName = (id?: string) => d.rooms.find(r => r.id === id)?.name ?? id ?? "";
  const refs = new RefTable(new Set(d.furniture.map(f => f.id)));
  /** 相对摆放的那件家具；找不到时记一条跳过说明，返回 null */
  const relTarget = (p: Beside | On, what: string) => {
    const r = refs.resolve(refKey(p)), it = "id" in r ? d.furniture.find(f => f.id === r.id) : undefined;
    if (!it) errors.push(`${"problem" in r ? r.problem : `找不到 ${refKey(p)}`}，${what}跳过`);
    return it ?? null;
  };
  const relText = (p: Beside | On, ref: Item) => "on" in p ? `，放在${name(ref)}上` : `，挨着${name(ref)}`;
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
          // 不管加没加成都要登记：自动名字的序号要和大模型数的一致（break 会先执行 finally）
          let added: string | null = null;
          try {
            const cat = CATALOG_BY_TYPE[op.type], nm = op.name ?? cat.nameZh;
            if (!d.rooms.some(r => r.id === op.room)) { errors.push(`房间 ${op.room} 不存在，没加 ${nm}`); break; }
            const fit = fitSize(op.type, (op.size ?? [...cat.defaultSize]) as Size3), size = fit.size;
            let pos: Vec2, rot = op.rot ?? 0, elevation = op.elevation, rel = "";
            if (op.place && "wall" in op.place) ({ pos, rot } = resolvePlace(d, { ...op.place, room: op.room }, size));
            else if (op.place) {
              const ref = relTarget(op.place, `没加 ${nm}，`); if (!ref) break;
              const r = resolveRelative(ref, op.place, op.type, size);
              ({ pos, rot } = r); if (r.elevation != null) elevation = r.elevation;
              rel = relText(op.place, ref);
            }
            else if (op.pos) pos = op.pos;
            else { errors.push(`${nm} 没给位置，跳过`); break; }
            if (op.rot != null) rot = op.rot;
            const it: Item = { id: newId(d, "ai"), type: op.type, name: nm, room: op.room, pos, rot, size };
            for (const k of ["spec", "variant", "finish", "optional", "note"] as const) if (op[k] != null) (it as Record<string, unknown>)[k] = op[k];
            if (op.color) it.color = (FABRIC_COLORS as Palette)[op.color];
            if (elevation) it.elevation = elevation;
            if (op.price != null) { it.price = op.price; it.priceBasis = "llm"; }
            if (cat.variants && it.variant && !cat.variants.includes(it.variant)) delete it.variant;
            d.furniture.push(it); touched.push(it.id);
            added = it.id;
            if (fit.note) sizeNotes.push(`${nm}：${fit.note}`);
            lines.push(`在${roomName(op.room)}加 ${nm}（${Math.round(size[0] * 100)}×${Math.round(size[1] * 100)} cm${op.price != null ? `，约 ¥${op.price}` : ""}${rel}）`);
          } finally { refs.add(op.type, op.ref, added); }
          break;
        }
        case "move": {
          const it = editable(op.id); if (!it) break;
          let where = "";
          if (op.place && "wall" in op.place) {
            // 不写 room 就是在原来的房间里换一面墙（2026-11-24 实测大模型常这样写）
            const room = op.place.room ?? it.room;
            if (!room) { errors.push(`${name(it)} 不在任何房间里，要写 room 才能靠墙放，跳过`); break; }
            const r = resolvePlace(d, { ...op.place, room }, it.size); it.pos = r.pos; it.rot = r.rot; it.room = room; where = `靠${DIR_ZH[op.place.wall]}墙`;
          }
          else if (op.place) {
            const ref = relTarget(op.place, `${name(it)} 没移动，`); if (!ref) break;
            if (ref.id === it.id) { errors.push(`${name(it)} 不能挨着自己放，跳过`); break; }
            const r = resolveRelative(ref, op.place, it.type, it.size);
            it.pos = r.pos; it.rot = r.rot; it.room = ref.room;
            if (r.elevation != null) it.elevation = r.elevation;
            where = relText(op.place, ref).slice(1);
          }
          else if (op.pos) it.pos = op.pos;
          if (op.rot != null) it.rot = op.rot;
          if (!op.place) it.room = d.rooms.find(r => pointInPolygon(it.pos, r.polygon))?.id ?? it.room;
          touched.push(it.id);
          lines.push(`把 ${name(it)} 移到${roomName(it.room)}${where}`);
          break;
        }
        case "update": {
          // 清单项（床垫、床品等）也用 update 改，大模型常这样用
          const ex = d.furniture.some(f => f.id === op.id) ? undefined : d.extras.find(x => x.id === op.id);
          if (ex) {
            const changed: string[] = [];
            for (const k of ["name", "spec", "optional", "note"] as const) {
              if (op[k] == null || ex[k] === op[k]) continue;
              (ex as Record<string, unknown>)[k] = op[k]; changed.push(FIELD_LABEL[k]);
            }
            if (op.price != null && op.price !== ex.price) { changed.push(`价格 ¥${ex.price} → 约 ¥${op.price}`); ex.price = op.price; ex.priceBasis = "llm"; }
            if (changed.length) lines.push(`改清单项 ${ex.name}：${changed.join("、")}`);
            else errors.push(`清单项 ${ex.name} 没有要改的地方，跳过`);
            break;
          }
          const it = editable(op.id); if (!it) break;
          const label = name(it), changed: string[] = [];
          let reshaped = false;
          // 只记真正变了的字段：大模型常把原值原样再写一遍
          if (op.size) {
            const fit = fitSize(it.type, op.size, it.size);
            if (fit.note) sizeNotes.push(`${label}：${fit.note}`);
            if (JSON.stringify(fit.size) !== JSON.stringify(it.size)) { it.size = fit.size; changed.push(`尺寸 ${fit.size.map(cmText).join("×")} cm`); reshaped = true; }
          }
          for (const k of ["name", "spec", "rot", "elevation", "variant", "finish", "optional", "note"] as const) {
            if (op[k] == null || JSON.stringify(it[k]) === JSON.stringify(op[k])) continue;
            (it as Record<string, unknown>)[k] = op[k];
            changed.push(k === "finish" ? `木色 ${WOOD_LABEL[op.finish!]}` : FIELD_LABEL[k]);
            if (k === "rot") reshaped = true;
          }
          if (op.color !== undefined) {
            const hex = op.color ? (FABRIC_COLORS as Palette)[op.color] : undefined;
            if ((hex ?? "").toUpperCase() !== (it.color ?? "").toUpperCase()) {
              if (hex) it.color = hex; else delete it.color;
              changed.push(op.color ? `颜色 ${op.color}` : "颜色跟随整体风格");
            }
          }
          if (op.price != null && op.price !== it.price) {
            changed.push(it.price == null ? `价格 约 ¥${op.price}` : `价格 ¥${it.price} → 约 ¥${op.price}`);
            it.price = op.price; it.priceBasis = "llm";
          }
          if (!changed.length) { errors.push(`${label} 没有要改的地方，跳过`); break; }
          if (reshaped) touched.push(it.id);
          lines.push(`改 ${label}：${changed.join("、")}`);
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
          const ch: string[] = [], skipped: string[] = [];
          if (op.floor && op.floor !== r.floor) { r.floor = op.floor; ch.push(`地面换成${FLOOR_LABEL[op.floor]}`); }
          if (op.wall && op.wall !== r.wall) { r.wall = op.wall; ch.push(`墙面换成${WALL_LABEL[op.wall]}`); }
          // 地板颜色只对木地板有效，墙面颜色只对乳胶漆有效（见 three/materials.ts）
          const color = (key: "floorColor" | "wallColor", v: string | null | undefined, palette: Palette, applies: boolean, label: string) => {
            if (v === undefined) return;
            const hex = v ? palette[v] : undefined;
            if ((hex ?? "").toUpperCase() === (r[key] ?? "").toUpperCase()) return;
            if (hex && !applies) { skipped.push(`${r.name}的${label}换不了（${key === "floorColor" ? "不是木地板" : "墙面不是乳胶漆"}），跳过`); return; }
            if (hex) { r[key] = hex; ch.push(`${label} ${v}`); } else { delete r[key]; ch.push(`${label}跟随整体风格`); }
          };
          color("floorColor", op.floorColor, FLOOR_COLORS, r.floor === "wood", "地板颜色");
          color("wallColor", op.wallColor, WALL_COLORS, r.wall === "paint", "墙面颜色");
          errors.push(...skipped);
          // 只把颜色设回跟随风格、而它本来就跟随风格时不提：2026-11-25 实测换风格时大模型会给每个房间都发一条
          const asked = op.floor || op.wall || op.floorColor || op.wallColor;
          if (ch.length) lines.push(`${r.name}：${ch.join("、")}`);
          else if (!skipped.length && asked) errors.push(`${r.name}的地面墙面本来就是这样，跳过`);
          break;
        }
        case "setTheme":
          if (d.theme === op.theme) { errors.push(`整体风格本来就是${THEMES[op.theme].nameZh}，跳过`); break; }
          d.theme = op.theme; lines.push(`整体风格换成${THEMES[op.theme].nameZh}`); break;
        case "addExtra": {
          if (op.room && !d.rooms.some(r => r.id === op.room)) { errors.push(`房间 ${op.room} 不存在，没加 ${op.name}`); break; }
          const e = { id: newId(d, "x"), name: op.name, price: op.price, priceBasis: "llm" as const, ...(op.spec ? { spec: op.spec } : {}), ...(op.room ? { room: op.room } : {}), ...(op.optional ? { optional: true } : {}), ...(op.note ? { note: op.note } : {}) };
          d.extras.push(e); addedExtras.push(e.id);
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
  return { house: out, lines, errors, warnings: [...sizeNotes, ...checkPlacement(out, touched), ...duplicateExtras(out, addedExtras)], touched };
}
/**
 * 清单项可能重复：新加的项和清单里别的项“核心名称”相同或互相包含。
 * 核心名称去掉括号里的说明、房间名、尺寸数字：“主卧1.5m床垫（独立袋装弹簧）”和“床垫”都是“床垫”。
 * 在套完所有指令后的结果上查，先加新的、后删旧的这种替换不算重复。
 */
export function duplicateExtras(h: House, ids: string[]): string[] {
  const rooms = h.rooms.map(r => r.name).sort((a, b) => b.length - a.length);
  const core = (s: string) => {
    let t = s.replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, "");
    for (const r of rooms) t = t.split(r).join("");
    return t.replace(/[\d.]+\s*(mm|cm|m|米)?|[×*]|[xX](?=\d)/g, "");
  };
  const out: string[] = [];
  for (const id of ids) {
    const e = h.extras.find(x => x.id === id); if (!e) continue;
    const c = core(e.name);
    const dup = h.extras.find(x => x.id !== id && (!x.room || !e.room || x.room === e.room) && (() => {
      const o = core(x.name), [a, b] = c.length <= o.length ? [c, o] : [o, c];
      return a.length >= 2 && b.includes(a);
    })());
    if (dup) out.push(`清单里已经有“${dup.name}”，和“${e.name}”可能重复了`);
  }
  return out;
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
    // 挡窗：窗前 0.3 m 内有高过窗台的东西（窗帘本来就挂在窗前，不算）。2026-11-24 实测通义千问常把床头顶在窗下
    const top = (it.elevation ?? 0) + it.size[2];
    if (it.type !== "curtain") for (const w of h.walls) for (const o of w.openings) {
      if (o.type !== "window" || top <= o.bottom + 0.02 || (it.elevation ?? 0) >= o.top) continue;
      const t = w.thickness / 2;
      const hit = [1, -1].some(sg => convexOverlap(fp, [wallPoint(w, o.offset, sg * t), wallPoint(w, o.offset + o.width, sg * t), wallPoint(w, o.offset + o.width, sg * (t + 0.3)), wallPoint(w, o.offset, sg * (t + 0.3))], 0.05));
      if (hit) out.push(`${nm} 挡住了窗`);
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
