/**
 * 户型识别的几何部分。纯计算，不调接口，全部有单元测试。
 *
 * 分工（2026-11-25 实测后定的）：识图模型认得出“这是主卧”“这是推拉门”、读得对干净图上的尺寸数字，
 * 但给不准任何位置——房间边界常差 0.3~1.2 m，连尺寸数字的位置都是编的。所以：
 * - 墙、洞口、房间的精确位置从像素里找（model/raster.ts）；
 * - 比例：把尺寸链的数字（轴线之间的距离）和找到的墙对上（matchAxes），不需要数字的位置；
 * - 房间名、类型、门窗类型：模型给的大概位置只用来“对号入座”（model/fuse.ts）。
 * 像素里找不出墙（比如墙画成空心双线的老图）时退回模型给的多边形（buildDraft），准度差，只当草稿。
 *
 * 本文件：
 * 1. 尺寸链：检查模型读到的数字可不可信（checkChains），算出轴线的相对位置，和墙对上求比例（matchAxes）；
 * 2. 房间多边形 → 横平竖直（rectify）→ 坐标吸附（snapCoords），矩形并集（unionPolygon）；
 * 3. 房间边界 → 墙（wallsFromRooms）；4. 门窗挂到墙上（placeOpenings）；最后组装（buildDraft）。
 */
import type { House, Opening, Room, Vec2, Wall } from "./schema";
import { ROOM_TYPES, roomDefaults } from "./schema";
import { pointInPolygon, polygonArea, signedArea, wallFrame } from "./geometry";

/* ---------- 1. 尺寸链 ---------- */
/** 一条尺寸链：h 是横着的一排（标的是竖墙之间的距离），v 是竖着的一列。mm 按从左到右、从上到下的顺序，读不出的是 null */
export interface Chain { dir: "h" | "v"; mm: (number | null)[]; total?: number }

const chainName = (ch: Chain) => `${ch.dir === "h" ? "横向" : "纵向"}尺寸 ${ch.mm.map(v => v ?? "?").join("、")}`;

/**
 * 检查模型读到的尺寸链。2026-11-25 实测模型会：读错一个数（2650 读成 2550）、多读一段、凭空编一排（17 个 2200）、
 * 同一排列两遍、把横着的一排又当成竖着的列一遍。
 * - 两段以下的不算链（单个数字多半是总长，拿来核对）；有读不出的数字的不用；
 * - 4 段以上都是同一个数的当成编的；数字完全一样的只留一条；
 * - 分段之和（或其中连续几段之和）等于同方向标的总长的，标成“核对过”，其余的提醒用户核对。
 */
export function checkChains(chains: Chain[]): { usable: (Chain & { ok: boolean })[]; problems: string[] } {
  const problems: string[] = [];
  const totals = chains.flatMap(ch => [...(ch.mm.length === 1 && ch.mm[0] ? [{ dir: ch.dir, total: ch.mm[0] }] : []), ...(ch.total ? [{ dir: ch.dir, total: ch.total }] : [])]);
  const seen = new Set<string>();
  const usable: (Chain & { ok: boolean })[] = [];
  for (const ch of chains) {
    if (ch.mm.length < 2) continue;
    if (ch.mm.some(v => !(v && v > 0))) { problems.push(`${chainName(ch)}：有读不出的数字，没用上`); continue; }
    if (ch.mm.length >= 4 && ch.mm.every(v => v === ch.mm[0])) { problems.push(`${chainName(ch)}：一整排都是同一个数，像是读错了，没用上`); continue; }
    const key = ch.mm.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const mm = ch.mm as number[];
    const ok = totals.some(t => t.dir === ch.dir && mm.some((_, i) => { let sum = 0; for (let j = i; j < mm.length; j++) { sum += mm[j]; if (j > i && Math.abs(sum - t.total) < 1) return true; } return false; }));
    usable.push({ ...ch, ok });
  }
  for (const t of totals) if (usable.some(c => c.dir === t.dir) && !usable.some(c => c.dir === t.dir && c.ok)) {
    problems.push(`${t.dir === "h" ? "横向" : "纵向"}总尺寸 ${t.total} 和各段加起来对不上，可能有数字读错了，请核对`);
  }
  return { usable, problems };
}

/** 一条链的轴线相对位置（米，第一条是 0） */
export function axesOf(ch: Chain): number[] {
  const out = [0];
  for (const v of ch.mm) out.push(out[out.length - 1] + (v ?? 0) / 1000);
  return out;
}

/**
 * 把轴线的相对位置（米）和图上找到的墙中线位置（像素）对上：求 像素 = o + s × 米，让尽量多的轴线落在墙上。
 * 候选来自“两条轴线对两面墙”的所有组合，数每个候选有几条轴线落在某面墙 tol 像素以内，取最多的（同样多取误差小的），
 * 再用对上的那些点最小二乘细调。s 限制在 [sMin, sMax] 像素/米（户型图一般 20~200，调用方可以按墙厚收窄）。
 * 只数落在墙的范围内的轴线（整栋楼的图，尺寸链比框出的一户长，框外的轴线本来就对不上）：
 * 对上的少于 3 条、或少于范围内的四分之三，返回 null。读错一个数时，它前面的轴线照样对得上，比例还是准的。
 * 注意：只有一条链、数字又全错时，也可能碰巧对上几条（单元测试里试过），所以调用方要拿横竖两个方向的比例互相核对。
 */
export function matchAxes(axes: number[], lines: number[], tol = 3, sMin = 15, sMax = 250): { s: number; o: number; matched: number; pairs: [number, number][] } | null {
  if (axes.length < 3 || lines.length < 2) return null;
  const ls = [...lines].sort((a, b) => a - b);
  // 最近的墙线：二分查找（整栋楼的尺寸链有十几段、墙有几十面，组合上万个，逐个比太慢）
  const near = (p: number) => {
    let lo = 0, hi = ls.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ls[m] < p) lo = m; else hi = m; }
    const a = Math.abs(ls[lo] - p), b = Math.abs(ls[hi] - p);
    return a <= b ? { d: a, at: ls[lo] } : { d: b, at: ls[hi] };
  };
  const lo = ls[0] - tol, hi = ls[ls.length - 1] + tol;
  let best: { s: number; o: number; n: number; err: number } | null = null;
  for (let i = 0; i < axes.length; i++) for (let k = i + 1; k < axes.length; k++) {
    for (let j = 0; j < ls.length; j++) for (let l = j + 1; l < ls.length; l++) {
      const s = (ls[l] - ls[j]) / (axes[k] - axes[i]);
      if (!(s >= sMin && s <= sMax)) continue;
      const o = ls[j] - s * axes[i];
      let n = 0, err = 0, inside = 0;
      for (const a of axes) { const p = o + s * a; if (p < lo || p > hi) continue; inside++; const { d } = near(p); if (d <= tol) { n++; err += d; } }
      if (n < Math.max(3, Math.ceil(inside * 0.75))) continue;
      if (!best || n > best.n || (n === best.n && err < best.err)) best = { s, o, n, err };
    }
  }
  if (!best) return null;
  // 用对上的点细调：最小二乘
  const pairs: [number, number][] = [];
  for (const a of axes) { const { d, at } = near(best.o + best.s * a); if (d <= tol) pairs.push([a, at]); }
  const n = pairs.length, ma = pairs.reduce((q, p) => q + p[0], 0) / n, ml = pairs.reduce((q, p) => q + p[1], 0) / n;
  let saa = 0, sal = 0;
  for (const [a, l] of pairs) { saa += (a - ma) ** 2; sal += (a - ma) * (l - ml); }
  const s = saa > 0 ? sal / saa : best.s;
  return { s, o: ml - s * ma, matched: n, pairs };
}

/* ---------- 2. 房间：横平竖直、吸附 ---------- */
/** 把一个大致横平竖直的多边形整理成严格横平竖直的；整理不了（斜边太多）就用外接矩形 */
export function rectify(poly: Vec2[]): Vec2[] {
  let p = poly.map(v => [v[0], v[1]] as Vec2);
  // 去掉几乎重合的点
  p = p.filter((v, i) => { const q = p[(i + 1) % p.length]; return Math.hypot(v[0] - q[0], v[1] - q[1]) > 1e-6; });
  const horiz = (a: Vec2, b: Vec2) => Math.abs(b[1] - a[1]) <= Math.abs(b[0] - a[0]);
  // 连续两条同方向的边合并（去掉中间的点）
  for (let changed = true; changed && p.length > 4;) {
    changed = false;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
      if (horiz(a, b) === horiz(b, c)) { p.splice(i, 1); changed = true; break; }
    }
  }
  const box = (): Vec2[] => {
    const xs = poly.map(v => v[0]), zs = poly.map(v => v[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  };
  if (p.length < 4 || p.length % 2) return box();
  const out = p.map(v => [v[0], v[1]] as Vec2);
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    if (horiz(p[i], p[j])) { const z = (p[i][1] + p[j][1]) / 2; out[i][1] = z; out[j][1] = z; }
    else { const x = (p[i][0] + p[j][0]) / 2; out[i][0] = x; out[j][0] = x; }
  }
  // 方向要交替（横、竖、横、竖），否则不是正常的横平竖直多边形
  for (let i = 0; i < out.length; i++) if (horiz(p[i], p[(i + 1) % p.length]) === horiz(p[(i + 1) % p.length], p[(i + 2) % p.length])) return box();
  return out;
}

/**
 * 一组坐标值（米）吸附：离轴线 axisTol 以内的吸到轴线；其余的，彼此相距 groupTol 以内的归成一组，取平均（保留到 5 cm）。
 * 返回 原值 → 吸附后的值 的函数。
 */
export function snapCoords(values: number[], axes: number[], axisTol = 0.35, groupTol = 0.25): (v: number) => number {
  const map = new Map<number, number>();
  const free: number[] = [];
  for (const v of values) {
    let best: number | null = null;
    for (const a of axes) if (Math.abs(a - v) <= axisTol && (best == null || Math.abs(a - v) < Math.abs(best - v))) best = a;
    if (best != null) map.set(v, best); else free.push(v);
  }
  free.sort((p, q) => p - q);
  for (let i = 0; i < free.length;) {
    let j = i + 1;
    while (j < free.length && free[j] - free[j - 1] <= groupTol && free[j] - free[i] <= groupTol * 1.6) j++;
    const g = free.slice(i, j), m = Math.round(g.reduce((s, v) => s + v, 0) / g.length * 20) / 20;
    for (const v of g) map.set(v, m);
    i = j;
  }
  return v => map.get(v) ?? v;
}

/**
 * 几个矩形 [x0, x1, z0, z1] 的并集 → 一个横平竖直的多边形（L 形房间由模型给成两个矩形）。
 * 在所有矩形边划出的格子上标出被盖住的格子，再沿边界走一圈。并集不连通时取面积最大的一块。
 */
export function unionPolygon(rects: [number, number, number, number][]): Vec2[] {
  const rs = rects.map(([a, b, c, d]) => [Math.min(a, b), Math.max(a, b), Math.min(c, d), Math.max(c, d)] as const).filter(r => r[1] - r[0] > 1e-6 && r[3] - r[2] > 1e-6);
  if (!rs.length) return [];
  const xs = [...new Set(rs.flatMap(r => [r[0], r[1]]))].sort((a, b) => a - b), zs = [...new Set(rs.flatMap(r => [r[2], r[3]]))].sort((a, b) => a - b);
  const nx = xs.length - 1, nz = zs.length - 1;
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < nz && rs.some(r => r[0] <= xs[i] + 1e-9 && xs[i + 1] <= r[1] + 1e-9 && r[2] <= zs[j] + 1e-9 && zs[j + 1] <= r[3] + 1e-9);
  // 边界上的有向边：被盖住的格子沿逆时针（在 x 右、z 下的坐标里）走，外侧没被盖住的边留下
  const next = new Map<string, [number, number]>();
  const key = (i: number, j: number) => `${i},${j}`;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    if (!on(i, j)) continue;
    if (!on(i, j - 1)) next.set(key(i, j), [i + 1, j]);          // 上边：左 → 右
    if (!on(i + 1, j)) next.set(key(i + 1, j), [i + 1, j + 1]);  // 右边：上 → 下
    if (!on(i, j + 1)) next.set(key(i + 1, j + 1), [i, j + 1]);  // 下边：右 → 左
    if (!on(i - 1, j)) next.set(key(i, j + 1), [i, j]);          // 左边：下 → 上
  }
  const loops: Vec2[][] = [];
  const used = new Set<string>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: [number, number][] = [];
    let cur = start;
    while (!used.has(cur) && next.has(cur)) { used.add(cur); const [i, j] = cur.split(",").map(Number); loop.push([i, j]); const n = next.get(cur)!; cur = key(n[0], n[1]); }
    // 去掉共线的点
    const pts = loop.filter((p, k) => { const a = loop[(k - 1 + loop.length) % loop.length], b = loop[(k + 1) % loop.length]; return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1])); });
    if (pts.length >= 4) loops.push(pts.map(([i, j]) => [xs[i], zs[j]] as Vec2));
  }
  return loops.sort((a, b) => polygonArea(b) - polygonArea(a))[0] ?? [];
}

/* ---------- 3. 房间边界 → 墙 ---------- */
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * 每条横线、竖线上，按房间的边覆盖了几次分段：2 次以上是内墙（两个房间共用），1 次是外墙。
 * 墙厚：在尺寸链的轴线上、或者是外墙的 20 cm（一般是承重墙、外墙），内墙 12 cm；阳台朝外的边是 10 cm 栏板。
 */
export function wallsFromRooms(rooms: Room[], axes: { xs: number[]; zs: number[] }): Wall[] {
  interface Edge { h: boolean; c: number; lo: number; hi: number; outdoor: boolean }
  const edges: Edge[] = [];
  for (const r of rooms) for (let i = 0; i < r.polygon.length; i++) {
    const a = r.polygon[i], b = r.polygon[(i + 1) % r.polygon.length];
    if (Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[0] - b[0]) > 1e-6) edges.push({ h: true, c: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), outdoor: !!r.outdoor });
    else if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) edges.push({ h: false, c: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]), outdoor: !!r.outdoor });
  }
  const lines = new Map<string, Edge[]>();
  for (const e of edges) { const k = `${e.h ? "h" : "v"}${r3(e.c)}`; (lines.get(k) ?? lines.set(k, []).get(k)!).push(e); }
  const onAxis = (h: boolean, c: number) => (h ? axes.zs : axes.xs).some(a => Math.abs(a - c) < 0.02);
  const walls: Wall[] = [];
  for (const es of lines.values()) {
    const { h, c } = es[0];
    const cuts = [...new Set(es.flatMap(e => [r3(e.lo), r3(e.hi)]))].sort((p, q) => p - q);
    type Kind = "in" | "out" | "rail";
    let cur: { lo: number; hi: number; kind: Kind } | null = null;
    const flush = () => {
      if (!cur || cur.hi - cur.lo < 0.05) { cur = null; return; }
      const axis = onAxis(h, c);
      const t = cur.kind === "rail" ? 0.1 : cur.kind === "out" || axis ? 0.2 : 0.12;
      const a: Vec2 = h ? [r3(cur.lo), r3(c)] : [r3(c), r3(cur.lo)], b: Vec2 = h ? [r3(cur.hi), r3(c)] : [r3(c), r3(cur.hi)];
      walls.push({ id: "w" + (walls.length + 1), a, b, thickness: t, kind: cur.kind === "rail" ? "railing" : "wall", openings: [] });
      cur = null;
    };
    for (let i = 0; i + 1 < cuts.length; i++) {
      const lo = cuts[i], hi = cuts[i + 1], mid = (lo + hi) / 2;
      const cover = es.filter(e => e.lo <= mid && mid <= e.hi);
      if (!cover.length) { flush(); continue; }
      // 阳台朝外的边：只有阳台一个房间，而且不在轴线上（轴线上的是主体墙，延伸到阳台也还是墙）
      const kind: Kind = cover.length >= 2 ? "in" : cover[0].outdoor && !onAxis(h, c) ? "rail" : "out";
      if (cur && cur.kind === kind && Math.abs(cur.hi - lo) < 1e-6) cur.hi = hi;
      else { flush(); cur = { lo, hi, kind }; }
    }
    flush();
  }
  return walls;
}

/* ---------- 4. 门窗 ---------- */
export interface OpeningGuess { type: Opening["type"]; at: Vec2; width?: number; rooms?: string[] }

const DEFAULT_WIDTH: Record<Opening["type"], number> = { door: 0.85, entry: 1.0, sliding: 1.8, window: 1.5, opening: 0.9 };
const WIDTH_RANGE: Record<Opening["type"], [number, number]> = { door: [0.6, 1.0], entry: [0.85, 1.4], sliding: [1.0, 4.0], window: [0.5, 4.0], opening: [0.6, 2.5] };

/**
 * 门窗挂到墙上：候选是中心离墙中线 0.6 m 以内、投影落在墙上的墙；
 * 模型说了门连着哪两个房间时，墙两侧正好是这两个房间的优先（名字对得上加分），再按距离。
 * 宽度用模型给的（限制在这类门窗的常见范围内），没给就用默认；和同一面墙上已有的门窗重叠就不放。
 */
export function placeOpenings(walls: Wall[], rooms: Room[], guesses: OpeningGuess[], H: number): { placed: number; dropped: number } {
  let placed = 0, dropped = 0, n = 0;
  const sideRoom = (w: Wall, u: number, sg: number) => {
    const { d, n: nn } = wallFrame(w), k = sg * (w.thickness / 2 + 0.25);
    const p: Vec2 = [w.a[0] + d[0] * u + nn[0] * k, w.a[1] + d[1] * u + nn[1] * k];
    return rooms.find(r => pointInPolygon(p, r.polygon));
  };
  for (const g of guesses) {
    let best: { w: Wall; u: number; score: number; plus?: Room; minus?: Room } | null = null;
    for (const w of walls) {
      if (w.kind === "railing" && g.type !== "window") continue;
      const { len, d, n: nn } = wallFrame(w);
      const rx = g.at[0] - w.a[0], rz = g.at[1] - w.a[1], u = rx * d[0] + rz * d[1], dist = Math.abs(rx * nn[0] + rz * nn[1]);
      if (dist > 0.6 || u < -0.1 || u > len + 0.1) continue;
      const plus = sideRoom(w, Math.min(Math.max(u, 0.1), len - 0.1), 1), minus = sideRoom(w, Math.min(Math.max(u, 0.1), len - 0.1), -1);
      const names = (g.rooms ?? []).filter(x => x && x !== "外面");
      const hit = names.filter(x => [plus, minus].some(r => r && (r.name === x || r.name.includes(x) || x.includes(r.name)))).length;
      // 窗、入户门在外墙上（有一侧没有房间）；室内门两侧都是房间
      const outside = !plus || !minus;
      const fits = (g.type === "window" || g.type === "entry") ? outside : !outside;
      const score = dist - hit * 0.5 - (fits ? 0.3 : 0);
      if (!best || score < best.score) best = { w, u, score, plus, minus };
    }
    if (!best) { dropped++; continue; }
    const { w, u } = best, { len } = wallFrame(w);
    const [lo, hi] = WIDTH_RANGE[g.type];
    let width = Math.min(Math.max(g.width ?? DEFAULT_WIDTH[g.type], lo), hi, len - 0.1);
    if (width < 0.4) { dropped++; continue; }
    width = Math.round(width * 100) / 100;
    const offset = Math.round(Math.min(Math.max(u - width / 2, 0.05), len - width - 0.05) * 100) / 100;
    if (w.openings.some(o => offset < o.offset + o.width && o.offset < offset + width)) { dropped++; continue; }
    const isWin = g.type === "window";
    const o: Opening = { id: (isWin ? "win" : "d") + ++n, type: g.type, offset, width, bottom: isWin ? 0.9 : 0, top: Math.min(isWin ? 2.3 : g.type === "sliding" ? 2.2 : 2.05, H - 0.1) };
    if (g.type === "door" || g.type === "entry") {
      // 门往房间里开：开向模型说的第一个房间（入户门开向屋里）
      const into = g.type === "entry" ? (best.plus ? 1 : -1) : best.plus && (g.rooms?.[0] ?? "") && best.plus.name.includes(g.rooms![0]) ? 1 : best.minus && g.rooms?.[0] && best.minus.name.includes(g.rooms[0]) ? -1 : 1;
      o.hinge = "a"; o.side = into as 1 | -1;
    }
    if (g.type === "sliding") o.panels = width > 2.4 ? 4 : 2;
    w.openings.push(o); placed++;
  }
  for (const w of walls) w.openings.sort((p, q) => p.offset - q.offset);
  return { placed, dropped };
}

/* ---------- 组装 ---------- */
export interface RoomGuess { name: string; type?: string; polygon: Vec2[]; area?: number }

export function guessRoomType(name: string): Room["type"] {
  const rules: [RegExp, Room["type"]][] = [[/阳台/, "balcony"], [/卫|浴|厕|洗手/, "bath"], [/厨/, "kitchen"], [/卧|房间/, "bedroom"], [/客厅|起居|客餐/, "living"], [/餐/, "dining"], [/玄关|门厅/, "entry"], [/过道|走廊|走道/, "hall"], [/书房/, "study"], [/储|衣帽/, "storage"]];
  return rules.find(([re]) => re.test(name))?.[1] ?? "other";
}

/**
 * 房间（米，已经换算好）→ 整理好的墙、房间、门窗。
 * axes 是轴线位置（米），没有尺寸链时传空数组。
 */
export function buildDraft(guesses: RoomGuess[], openings: OpeningGuess[], axes: { xs: number[]; zs: number[] }, H = 2.75): { walls: Wall[]; rooms: Room[]; problems: string[]; dropped: number } {
  const problems: string[] = [];
  let dropped = 0;
  const polys = guesses.map(g => rectify(g.polygon));
  const sx = snapCoords(polys.flatMap(p => p.map(v => v[0])), axes.xs);
  const sz = snapCoords(polys.flatMap(p => p.map(v => v[1])), axes.zs);
  const rooms: Room[] = [];
  guesses.forEach((g, i) => {
    let poly = polys[i].map(v => [r3(sx(v[0])), r3(sz(v[1]))] as Vec2);
    poly = poly.filter((v, k) => { const q = poly[(k + 1) % poly.length]; return v[0] !== q[0] || v[1] !== q[1]; });
    // 吸附后共线的点去掉
    poly = poly.filter((v, k) => {
      const a = poly[(k - 1 + poly.length) % poly.length], b = poly[(k + 1) % poly.length];
      return !((a[0] === v[0] && v[0] === b[0]) || (a[1] === v[1] && v[1] === b[1]));
    });
    if (poly.length < 3 || polygonArea(poly) < 0.3) { dropped++; return; }
    if (signedArea(poly) < 0) poly.reverse();
    const type = (ROOM_TYPES as readonly string[]).includes(g.type ?? "") ? g.type as Room["type"] : guessRoomType(g.name);
    const name = g.name.slice(0, 20) || `房间 ${rooms.length + 1}`;
    rooms.push({ id: "r" + (rooms.length + 1), name, type, polygon: poly, ...roomDefaults(type) });
    if (g.area && g.area > 1) {
      // 图上的面积是套内的，按墙中线算会大一些；差太多说明这个房间的范围认错了
      const a = polygonArea(poly);
      if (a < g.area * 0.9 || a > g.area * 1.6) problems.push(`${name}：图上标 ${g.area} ㎡，识别出的按墙中线算是 ${a.toFixed(1)} ㎡，范围可能不对`);
    }
  });
  const walls = wallsFromRooms(rooms, axes);
  const op = placeOpenings(walls, rooms, openings, H);
  dropped += op.dropped;
  return { walls, rooms, problems, dropped };
}

/**
 * 用识别出的墙、房间和底图标定替换方案里的。家具和清单保留（通常是新方案，没有家具）；
 * 家具原来所在的房间没了就不再记房间；识别出的 id 和已有家具重名时加后缀。
 */
export function applyDraft(h: House, d: { walls: Wall[]; rooms: Room[]; background?: Pick<NonNullable<House["background"]>, "pxPerM" | "pxPerMz" | "origin"> }): House {
  const out = structuredClone(h);
  const taken = new Set([...h.furniture.map(f => f.id), ...h.extras.map(e => e.id)]);
  const fresh = (id: string) => { let v = id, k = 2; while (taken.has(v)) v = `${id}_${k++}`; taken.add(v); return v; };
  out.walls = d.walls.map(w => ({ ...w, id: fresh(w.id), openings: w.openings.map(o => ({ ...o, id: fresh(o.id) })) }));
  out.rooms = d.rooms.map(r => ({ ...r, id: fresh(r.id) }));
  if (d.background) out.background = { opacity: h.background?.opacity ?? 0.5, ...d.background };
  for (const f of out.furniture) if (f.room && !out.rooms.some(r => r.id === f.room)) delete f.room;
  for (const e of out.extras) if (e.room && !out.rooms.some(r => r.id === e.room)) delete e.room;
  return out;
}
