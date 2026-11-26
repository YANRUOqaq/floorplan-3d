/**
 * 识别结果融合：像素里找到的墙、洞口、房间（raster.ts，位置准、不知道叫什么）
 * + 模型读到的尺寸数字（draft.ts 的 checkChains，数字准、位置不准）
 * + 模型认出的房间名和门窗类型（位置只准到一米左右）
 * → 墙、门窗、房间（米）。纯计算，有单元测试。
 *
 * 比例由 scale.ts 先算好（尺寸链对墙中线、总尺寸对外墙、面积互相核对）。
 */
import type { Opening, Room, Vec2, Wall } from "./schema";
import { ROOM_TYPES, roomDefaults } from "./schema";
import { bbox, pointInPolygon, polygonArea, signedArea, wallFrame } from "./geometry";
import { guessRoomType } from "./draft";
import type { ScaleResult } from "./scale";
import type { Detection, PxGap } from "./raster";

/**
 * 模型认出的房间和门窗（原图像素）。按编号回答时（见 llm/recognize.ts 的 marksPrompt），at 是程序画标记的位置（准）；
 * 退路里模型自己报的多边形和位置只准到一米左右。
 */
export interface VlmRoom { name: string; type?: string; area?: number; at?: Vec2; polygon?: Vec2[] }
export interface VlmOpening { type: Opening["type"] | "none"; at: Vec2; widthPx?: number; rooms?: string[] }

/** 房间的代表点：有标记位置用标记位置，没有用多边形各顶点的平均 */
export function anchorOf(v: VlmRoom): Vec2 | null {
  if (v.at) return v.at;
  if (!v.polygon?.length) return null;
  return [v.polygon.reduce((q, p) => q + p[0], 0) / v.polygon.length, v.polygon.reduce((q, p) => q + p[1], 0) / v.polygon.length];
}

/**
 * 在房间里找一个画编号的位置：房间最宽敞处（离墙最远的点）的左边或右边、隔开约 3.5 个标记半径。
 * 房间名和面积一般写在最宽敞处的正中，横着偏开就不会挡住；也不要放到墙角——
 * 2026-11-26 实测编号放在墙角时，模型会按旁边的东西起名（客厅角上的橱柜让它叫成“厨房”，入户门边的叫成“玄关”）。
 * 房间太小放不下就放在最宽敞处。在外接矩形里取 20×20 个点试。
 */
export function markAnchor(poly: Vec2[], clear: number): Vec2 {
  const b = bbox(poly);
  const edgeDist = (p: Vec2) => {
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length], vx = c[0] - a[0], vz = c[1] - a[1], L = vx * vx + vz * vz;
      const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / L)) : 0;
      d = Math.min(d, Math.hypot(p[0] - a[0] - vx * t, p[1] - a[1] - vz * t));
    }
    return d;
  };
  const pts: { p: Vec2; d: number }[] = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
    const p: Vec2 = [b.x0 + (b.x1 - b.x0) * (i + 0.5) / 20, b.z0 + (b.z1 - b.z0) * (j + 0.5) / 20];
    if (pointInPolygon(p, poly)) pts.push({ p, d: edgeDist(p) });
  }
  if (!pts.length) return [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2];
  const pole = pts.reduce((q, x) => x.d > q.d ? x : q);
  if (pole.d < 2 * clear) return pole.p;
  const off = 3.5 * clear, targets: Vec2[] = [[pole.p[0] - off, pole.p[1]], [pole.p[0] + off, pole.p[1]], [pole.p[0], pole.p[1] - off], [pole.p[0], pole.p[1] + off]];
  let best = pole.p, score = Infinity;
  for (const x of pts) {
    if (x.d < clear) continue;
    const sc = Math.min(...targets.map((t, k) => Math.hypot(x.p[0] - t[0], x.p[1] - t[1]) + k * clear * 0.5));
    if (sc < score) { score = sc; best = x.p; }
  }
  return best;
}

export interface Fused {
  walls: Wall[];
  rooms: Room[];
  /** 横向、纵向每米多少像素 */
  sx: number; sz: number;
  problems: string[];
}

/** A 里有多大比例落在 B 里（在 A 的外接矩形里取 20×20 个点数） */
export function overlapRatio(A: Vec2[], B: Vec2[]): number {
  const b = bbox(A);
  let inA = 0, both = 0;
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
    const p: Vec2 = [b.x0 + (b.x1 - b.x0) * (i + 0.5) / 20, b.z0 + (b.z1 - b.z0) * (j + 0.5) / 20];
    if (!pointInPolygon(p, A)) continue;
    inA++;
    if (pointInPolygon(p, B)) both++;
  }
  return inA ? both / inA : 0;
}

/** 两个多边形的交并比：在合起来的外接矩形里取 40×40 个点数（像素坐标也能用，和尺度无关） */
export function sampledIoU(A: Vec2[], B: Vec2[]): number {
  const a = bbox(A), b = bbox(B);
  if (a.x1 <= b.x0 || b.x1 <= a.x0 || a.z1 <= b.z0 || b.z1 <= a.z0) return 0;
  const x0 = Math.min(a.x0, b.x0), x1 = Math.max(a.x1, b.x1), z0 = Math.min(a.z0, b.z0), z1 = Math.max(a.z1, b.z1);
  let inter = 0, uni = 0;
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) {
    const p: Vec2 = [x0 + (x1 - x0) * (i + 0.5) / 40, z0 + (z1 - z0) * (j + 0.5) / 40];
    const ia = pointInPolygon(p, A), ib = pointInPolygon(p, B);
    if (ia && ib) inter++;
    if (ia || ib) uni++;
  }
  return uni ? inter / uni : 0;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 模型报的面积配到像素房间上（代表点落在哪个房间就是哪个，一个房间只配一次），给比例估计用 */
export function areasOnPixelRooms(det: Detection, vlmRooms: VlmRoom[]): { polygon: Vec2[]; area: number }[] {
  const used = new Set<number>();
  return vlmRooms.filter(v => v.area).flatMap(v => {
    const p = anchorOf(v), i = p ? det.rooms.findIndex(r => pointInPolygon(p, r.polygon)) : -1;
    if (i < 0 || used.has(i)) return [];
    used.add(i);
    return [{ polygon: det.rooms[i].polygon, area: v.area! }];
  });
}

/** 一条墙线（像素）：同一条直线上连起来的墙段和洞口；holes 是其中的门窗（gap 是来自 det.gaps 的第几个） */
export interface WallRun { h: boolean; c: number; lo: number; hi: number; t: number; holes: { lo: number; hi: number; kind: PxGap["kind"]; gap: number }[] }

/**
 * 把像素里的墙段和洞口按直线归组，沿线把首尾相接（或只隔一个墙厚，比如 T 形交接处横穿的墙）的连成一面墙，洞口变成门窗。
 * 2026-11-26 真实图上的几种情况都要能连上：两扇门中间只隔一面横墙（T 形交接）、门紧挨墙角（洞口在墙的一头）、
 * 整面外墙都是窗（这条线上没有实心段）、一段长窗盖过了中间几小块实心墙（洞口和墙段重叠的部分算墙）。
 * 不在任何墙线上的空缺（家具细线、衣柜门这类）用不上，发给模型认的图上也不标。
 */
export function wallRuns(det: Detection): WallRun[] {
  type Item = { h: boolean; c: number; lo: number; hi: number; t: number; gap: number; kind?: PxGap["kind"] };
  const items: Item[] = [
    ...det.walls.map(w => ({ w, gap: -1, kind: undefined as PxGap["kind"] | undefined })),
    ...det.gaps.map((w, i) => ({ w, gap: i, kind: w.kind as PxGap["kind"] | undefined })),
  ].map(({ w, gap, kind }) => {
    const h = Math.abs(w.a[1] - w.b[1]) < Math.abs(w.a[0] - w.b[0]);
    return { h, c: h ? (w.a[1] + w.b[1]) / 2 : (w.a[0] + w.b[0]) / 2, lo: h ? Math.min(w.a[0], w.b[0]) : Math.min(w.a[1], w.b[1]), hi: h ? Math.max(w.a[0], w.b[0]) : Math.max(w.a[1], w.b[1]), t: w.t, gap, kind };
  }).filter(x => x.hi > x.lo);
  const T = det.wallThickness, lineTol = Math.max(2, T / 2), join = Math.max(lineTol, T * 1.2), minHole = Math.max(4, T * 1.5);
  // 先按直线归组（墙段在前、长的在前定下这条线的位置）
  const groups: { h: boolean; c: number; items: Item[] }[] = [];
  for (const it of [...items].sort((a, b) => (a.gap < 0 ? 0 : 1) - (b.gap < 0 ? 0 : 1) || (b.hi - b.lo) - (a.hi - a.lo))) {
    const g = groups.find(g => g.h === it.h && Math.abs(g.c - it.c) <= (it.gap < 0 ? lineTol : lineTol * 2));
    if (g) g.items.push(it); else groups.push({ h: it.h, c: it.c, items: [it] });
  }
  const runs: WallRun[] = [];
  for (const g of groups) {
    g.items.sort((a, b) => a.lo - b.lo);
    let chain: Item[] = [], hi = -Infinity;
    const flush = () => {
      if (!chain.length) return;
      const solids = chain.filter(x => x.gap < 0);
      const run: WallRun = { h: g.h, c: g.c, lo: Math.min(...chain.map(x => x.lo)), hi: Math.max(...chain.map(x => x.hi)), t: Math.max(...(solids.length ? solids : chain).map(x => x.t)), holes: [] };
      // 洞口去掉和墙段、和别的洞口重叠的部分（长的洞口先占），剩下够宽的才算门窗
      const taken: [number, number][] = solids.map(x => [x.lo, x.hi]);
      for (const x of chain.filter(x => x.gap >= 0).sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo))) {
        let pieces: [number, number][] = [[x.lo, x.hi]];
        for (const [a, b] of taken) pieces = pieces.flatMap(([p, q]): [number, number][] => b <= p || a >= q ? [[p, q]] : [...(a > p ? [[p, a] as [number, number]] : []), ...(b < q ? [[b, q] as [number, number]] : [])]);
        for (const [p, q] of pieces) if (q - p >= minHole) { run.holes.push({ lo: p, hi: q, kind: x.kind!, gap: x.gap }); taken.push([p, q]); }
      }
      run.holes.sort((a, b) => a.lo - b.lo);
      // 只有洞口、没有实心段，而且洞口加起来不到一米多的，多半是检测出来的零碎空缺，不成墙
      if (solids.length || run.holes.reduce((q, h) => q + h.hi - h.lo, 0) >= 6 * T) runs.push(run);
      chain = [];
    };
    for (const it of g.items) {
      if (chain.length && it.lo > hi + join) flush();
      chain.push(it); hi = chain.length === 1 ? it.hi : Math.max(hi, it.hi);
    }
    flush();
  }
  return runs;
}

/** scale 是 estimateScale（scale.ts）算好的比例，problems 接着它的往下写 */
export function fuse(det: Detection, scale: ScaleResult, vlmRooms: VlmRoom[], vlmOpenings: VlmOpening[], H = 2.75, missing: string[] = []): Fused {
  const problems: string[] = [...scale.problems];
  const { sx, sz } = scale;
  const M = (p: Vec2): Vec2 => [r2(p[0] / sx), r2(p[1] / sz)];

  /* ---- 2. 房间：像素里的区域 + 模型给的名字（代表点落在哪个房间里就是哪个房间的名字） ---- */
  const nameOf = new Map<number, VlmRoom>(), named = new Set<VlmRoom>(), together = new Map<number, string[]>();
  for (const v of vlmRooms) {
    const p = anchorOf(v), i = p ? det.rooms.findIndex(r => pointInPolygon(p, r.polygon)) : -1;
    if (i < 0) continue;
    named.add(v);
    if (!nameOf.has(i)) nameOf.set(i, v); else together.set(i, [...(together.get(i) ?? [nameOf.get(i)!.name]), v.name]);
  }
  const rooms: Room[] = [];
  const usedNames = new Map<string, number>();
  for (const i of det.rooms.map((_, i) => i).sort((a, b) => det.rooms[b].area - det.rooms[a].area)) {
    const r = det.rooms[i], v = nameOf.get(i) ?? null;
    let name = v?.name.slice(0, 20) || "房间";
    const n = (usedNames.get(name) ?? 0) + 1; usedNames.set(name, n);
    if (n > 1 || !v) name = `${name} ${n}`;
    const type = v && (ROOM_TYPES as readonly string[]).includes(v.type ?? "") ? v.type as Room["type"] : guessRoomType(v?.name ?? "");
    let poly = r.polygon.map(M);
    if (signedArea(poly) < 0) poly = poly.reverse();
    rooms.push({ id: "r" + (rooms.length + 1), name, type, polygon: poly, ...roomDefaults(type) });
    if (v?.area && v.area > 1) {
      const a = polygonArea(poly);
      if (a < v.area * 0.9 || a > v.area * 1.6) problems.push(`${name}：图上标 ${v.area} ㎡，识别出的按墙中线算是 ${a.toFixed(1)} ㎡，范围可能不对`);
    }
  }
  for (const names of together.values()) problems.push(`${names.join("、")}识别成了同一个房间，中间的墙可能没找到，请对照底图补上`);
  const missed = [...vlmRooms.filter(v => !named.has(v)).map(v => v.name), ...missing];
  if (missed.length) problems.push(`模型说图上还有${[...new Set(missed)].join("、")}，但没找到围住它的墙，请手动补上`);

  /* ---- 3. 墙：同一条线上被洞口隔开的几段合成一面墙（wallRuns，像素），洞口变成门窗 ---- */
  const walls: Wall[] = [];
  const vlmPx = vlmOpenings, fromModel = new Set<Opening>();
  let on = 0;
  for (const run of wallRuns(det)) {
    const a: Vec2 = run.h ? [run.lo, run.c] : [run.c, run.lo], b: Vec2 = run.h ? [run.hi, run.c] : [run.c, run.hi];
    const w: Wall = { id: "w" + (walls.length + 1), a: M(a), b: M(b), thickness: Math.min(0.4, Math.max(0.06, r2(run.t / ((sx + sz) / 2)))), kind: "wall", openings: [] };
    if (wallFrame(w).len < 0.1) continue;
    for (const hole of run.holes) {
      const u0 = r2((hole.lo - run.lo) / (run.h ? sx : sz)), width = r2((hole.hi - hole.lo) / (run.h ? sx : sz));
      const mid: Vec2 = run.h ? [(hole.lo + hole.hi) / 2, run.c] : [run.c, (hole.lo + hole.hi) / 2];
      // 门窗类型：是窗还是门先听像素（洞口里有和墙平行的细线是窗、旁边有门扇和圆弧是门），模型在同一类里细分：
      // 像素是窗、模型说推拉门 → 推拉门（推拉门也画成细线）；像素是门、模型说入户门或推拉门 → 照它；像素什么都看不出 → 听模型。
      // 2026-11-26 合成图上让模型全权定类型，13 个门窗有 5 个把窗和门说反了。模型说“不是门窗”（none）的当墙。
      // 只认 0.5 m 内的回答（按编号回答时位置就是洞口中心；退路里模型自己报的位置差一米左右，2026-11-25 实测会张冠李戴）
      const v = vlmPx.map(o => ({ o, d: Math.hypot(o.at[0] - mid[0], o.at[1] - mid[1]) / ((sx + sz) / 2) })).filter(x => x.d <= 0.5).sort((p, q) => p.d - q.d)[0]?.o;
      if (v?.type === "none") continue;
      const vt = v?.type as Opening["type"] | undefined;
      const type: Opening["type"] = hole.kind === "window" ? (vt === "sliding" ? "sliding" : "window")
        : hole.kind === "door" ? (vt === "entry" || vt === "sliding" ? vt : "door")
        : vt ?? "opening";
      const isWin = type === "window";
      const o: Opening = { id: (isWin ? "win" : "d") + ++on, type, offset: Math.max(0, u0), width: Math.min(width, wallFrame(w).len - Math.max(0, u0)), bottom: isWin ? 0.9 : 0, top: Math.min(isWin ? 2.3 : type === "sliding" ? 2.2 : 2.05, H - 0.1) };
      if (type === "door" || type === "entry") { o.hinge = "a"; o.side = 1; }
      if (type === "sliding") o.panels = width > 2.4 ? 4 : 2;
      if (o.width >= 0.3) { w.openings.push(o); if (v) fromModel.add(o); }
    }
    walls.push(w);
  }
  // 模型没回答的洞口，看两侧是什么：外墙上的门（一侧没有房间）是入户门；两侧都是房间的“窗”实际是推拉门（客厅通阳台、厨房通生活阳台）
  for (const w of walls) {
    const { d, n } = wallFrame(w);
    for (const o of w.openings) {
      if (fromModel.has(o)) continue;
      const u = o.offset + o.width / 2, k = w.thickness / 2 + 0.25;
      const side = [1, -1].map(sg => rooms.find(r => pointInPolygon([w.a[0] + d[0] * u + n[0] * k * sg, w.a[1] + d[1] * u + n[1] * k * sg], r.polygon)));
      const both = side.every(Boolean);
      if ((o.type === "door" || o.type === "opening") && !both && !side.some(r => r?.outdoor)) { o.type = "entry"; o.hinge = "a"; o.side = side[0] ? 1 : -1; }
      if (o.type === "window" && both) { o.type = "sliding"; o.bottom = 0; o.top = Math.min(2.2, H - 0.1); o.panels = o.width > 2.4 ? 4 : 2; }
    }
  }
  return { walls, rooms, sx, sz, problems };
}
