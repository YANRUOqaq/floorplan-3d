/**
 * 户型图识别（实验功能）：让能看图的大模型按“图片像素坐标”返回墙、门窗、房间，
 * 由程序换算成米并整理（横平竖直、合并端点、门窗挂到最近的墙上），作为草稿交给编辑器。
 *
 * 为什么让大模型给像素而不是米：它读图上的尺寸数字常常读错，算比例也容易错；
 * 比例已经由用户标定过，程序换算更可靠。识别结果只当草稿，用户要对照底图检查。
 */
import { z } from "zod";
import type { Background, House, Opening, Room, Vec2, Wall } from "../model/schema";
import { ROOM_TYPES, roomDefaults } from "../model/schema";
import { polygonArea, wallFrame } from "../model/geometry";
import { chat, extractJson, LlmError } from "./client";
import type { LlmSettings } from "./providers";

const P = z.tuple([z.number(), z.number()]);
export const Recognition = z.object({
  walls: z.array(z.object({ a: P, b: P, thickness: z.number().positive().optional() })).default([]),
  openings: z.array(z.object({ type: z.enum(["door", "entry", "sliding", "window", "opening"]), a: P, b: P })).default([]),
  rooms: z.array(z.object({ name: z.string(), type: z.string().optional(), polygon: z.array(P).min(3) })).default([]),
});
export type Recognition = z.infer<typeof Recognition>;

export function recognitionPrompt(w: number, h: number) {
  return `这是一张住宅户型图，图片宽 ${w} 像素、高 ${h} 像素，左上角是 (0, 0)，x 向右，y 向下。
请识别图中这一户的墙、门窗和房间，坐标一律用这张图片的像素坐标，只输出一个 JSON 对象：
{"walls":[{"a":[x,y],"b":[x,y],"thickness":墙厚像素}],
 "openings":[{"type":"door|entry|sliding|window|opening","a":[x,y],"b":[x,y]}],
 "rooms":[{"name":"图上写的房间名，比如 主卧","type":"${ROOM_TYPES.join("|")}","polygon":[[x,y],...]}]}
要求：
- 墙用中心线表示，a、b 是墙的两个端点；一面直墙只给一段，墙和墙在拐角处的端点要重合。
- 门窗的 a、b 是洞口在墙中心线上的两端；入户门用 entry，推拉门用 sliding，没有门扇的门洞用 opening。
- 房间多边形沿墙中心线描，按顺序给出各个角。
- 只识别图中主要的那一户；图上的家具、尺寸标注线、轴线编号都不要当成墙。
- 不确定的部分宁可不给。不要输出 JSON 以外的文字。`;
}

export interface CropMapping {
  /** 发给大模型的图片在原图里的左上角和缩放（原图像素 = 偏移 + 发送图像素 × scale） */
  offset: Vec2;
  scale: number;
  bg: Pick<Background, "pxPerM" | "pxPerMz" | "origin">;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 识别结果 → 墙和房间（米）。整理规则见文件开头 */
export function draftFromRecognition(rec: Recognition, map: CropMapping, wallHeight = 2.75): { walls: Wall[]; rooms: Room[]; dropped: number } {
  const sz = map.bg.pxPerMz ?? map.bg.pxPerM;
  const toWorld = (p: Vec2): Vec2 => {
    const ix = map.offset[0] + p[0] * map.scale, iy = map.offset[1] + p[1] * map.scale;
    return [(ix - map.bg.origin[0]) / map.bg.pxPerM, (iy - map.bg.origin[1]) / sz];
  };
  let dropped = 0;
  // 1. 墙：换算、接近水平竖直的拉正
  let segs = rec.walls.map(w => {
    let a = toWorld(w.a), b = toWorld(w.b);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), lim = 10 * Math.PI / 180;
    const nearH = Math.abs(Math.sin(ang)) < Math.sin(lim), nearV = Math.abs(Math.cos(ang)) < Math.sin(lim);
    if (nearH) { const z = (a[1] + b[1]) / 2; a = [a[0], z]; b = [b[0], z]; }
    else if (nearV) { const x = (a[0] + b[0]) / 2; a = [x, a[1]]; b = [x, b[1]]; }
    const t = w.thickness ? w.thickness * map.scale / map.bg.pxPerM : 0.2;
    return { a, b, t: Math.min(0.3, Math.max(0.1, Math.round(t * 50) / 50)) };
  });
  // 2. 合并相近的端点（15 cm 以内的归成一个点，取平均）
  const pts: Vec2[] = segs.flatMap(s => [s.a, s.b]);
  const groups: Vec2[][] = [];
  for (const p of pts) {
    const g = groups.find(g => Math.hypot(g[0][0] - p[0], g[0][1] - p[1]) < 0.15);
    if (g) g.push(p); else groups.push([p]);
  }
  for (const g of groups) {
    const x = r2(g.reduce((s, p) => s + p[0], 0) / g.length), z = r2(g.reduce((s, p) => s + p[1], 0) / g.length);
    for (const p of g) { p[0] = x; p[1] = z; }
  }
  segs = segs.filter(s => { const ok = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) >= 0.2; if (!ok) dropped++; return ok; });
  const walls: Wall[] = segs.map((s, i) => ({ id: "w" + (i + 1), a: s.a, b: s.b, thickness: s.t, kind: "wall", openings: [] }));
  // 3. 门窗：挂到离中心最近的墙上
  let on = 0;
  for (const o of rec.openings) {
    const a = toWorld(o.a), b = toWorld(o.b), c: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let best: { w: Wall; u0: number; u1: number; d: number } | null = null;
    for (const w of walls) {
      const { len, d, n } = wallFrame(w);
      const proj = (p: Vec2) => (p[0] - w.a[0]) * d[0] + (p[1] - w.a[1]) * d[1];
      const dist = Math.abs((c[0] - w.a[0]) * n[0] + (c[1] - w.a[1]) * n[1]), uc = proj(c);
      if (uc < 0 || uc > len || dist > 0.3) continue;
      if (!best || dist < best.d) { const [u0, u1] = [proj(a), proj(b)].sort((x, y) => x - y); best = { w, u0: Math.max(0, u0), u1: Math.min(len, u1), d: dist }; }
    }
    if (!best || best.u1 - best.u0 < 0.3) { dropped++; continue; }
    const H = wallHeight, isWin = o.type === "window";
    const op: Opening = { id: (isWin ? "win" : "d") + (++on), type: o.type, offset: r2(best.u0), width: r2(best.u1 - best.u0), bottom: isWin ? 0.9 : 0, top: Math.min(isWin ? 2.3 : o.type === "sliding" ? 2.2 : 2.05, H - 0.1) };
    if (o.type === "door" || o.type === "entry") { op.hinge = "a"; op.side = 1; }
    if (o.type === "sliding") op.panels = 2;
    if (best.w.openings.some(x => op.offset < x.offset + x.width && x.offset < op.offset + op.width)) { dropped++; continue; }
    best.w.openings.push(op);
  }
  // 4. 房间
  const rooms: Room[] = [];
  rec.rooms.forEach((r, i) => {
    const poly = r.polygon.map(p => { const q = toWorld(p); return [r2(q[0]), r2(q[1])] as Vec2; });
    if (polygonArea(poly) < 0.5) { dropped++; return; }
    const type = (ROOM_TYPES as readonly string[]).includes(r.type ?? "") ? r.type as Room["type"] : guessType(r.name);
    rooms.push({ id: "r" + (i + 1), name: r.name.slice(0, 20) || `房间 ${i + 1}`, type, polygon: poly, ...roomDefaults(type) });
  });
  return { walls, rooms, dropped };
}

function guessType(name: string): Room["type"] {
  const rules: [RegExp, Room["type"]][] = [[/卧/, "bedroom"], [/客厅|起居/, "living"], [/餐/, "dining"], [/厨/, "kitchen"], [/卫|浴|厕/, "bath"], [/阳台/, "balcony"], [/玄关|门厅/, "entry"], [/过道|走廊/, "hall"], [/书房/, "study"], [/储|衣帽/, "storage"]];
  return rules.find(([re]) => re.test(name))?.[1] ?? "other";
}

/** 调用识图模型。image 是 data URL */
export async function recognize(s: LlmSettings, image: string, w: number, h: number, opts: { signal?: AbortSignal; fetchFn?: typeof fetch } = {}): Promise<Recognition> {
  if (!s.visionModel) throw new LlmError("还没填识图模型。在“大模型”面板的设置里填一个能看图的模型（比如通义千问的 qwen-vl-max）。");
  const text = await chat(s, [{ role: "user", content: [{ type: "text", text: recognitionPrompt(w, h) }, { type: "image_url", image_url: { url: image } }] }], { model: s.visionModel, signal: opts.signal, fetchFn: opts.fetchFn });
  let raw: unknown;
  try { raw = extractJson(text); } catch { throw new LlmError("识图模型没有返回 JSON。可以换一个识图模型再试。"); }
  const r = Recognition.safeParse(raw);
  if (!r.success) throw new LlmError("识图模型返回的格式不对：" + r.error.issues.slice(0, 3).map(i => i.path.join(".") + " " + i.message).join("；"));
  return r.data;
}

/**
 * 把一个 House 的墙和房间换成识别结果。家具、清单和其他设置保留；
 * 家具原来所在的房间没了就不再记房间；识别结果的 id 和已有家具重名时加后缀。
 */
export function applyDraft(h: House, d: { walls: Wall[]; rooms: Room[] }): House {
  const out = structuredClone(h);
  const taken = new Set([...h.furniture.map(f => f.id), ...h.extras.map(e => e.id)]);
  const fresh = (id: string) => { let v = id, k = 2; while (taken.has(v)) v = `${id}_${k++}`; taken.add(v); return v; };
  out.walls = d.walls.map(w => ({ ...w, id: fresh(w.id), openings: w.openings.map(o => ({ ...o, id: fresh(o.id) })) }));
  out.rooms = d.rooms.map(r => ({ ...r, id: fresh(r.id) }));
  for (const f of out.furniture) if (f.room && !out.rooms.some(r => r.id === f.room)) delete f.room;
  for (const e of out.extras) if (e.room && !out.rooms.some(r => r.id === e.room)) delete e.room;
  return out;
}
