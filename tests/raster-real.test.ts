/**
 * 真实户型图上的像素检测评测（只在本地跑：图和答案在 local/eval/，带水印、版权不明，不进仓库；没有就跳过）。
 * 只看 detectPlan 本身（像素坐标），不经过大模型和融合：
 * - 有完整答案的（rNN.truth.snapped.json，像素坐标）：墙覆盖、多出来的墙、洞口、房间交并比；
 * - cases.json 里的房间点（check.rooms）：每个点有没有落在检测出的房间里，不同房间的点是不是落在不同的房间里（客厅、餐厅可以同一间）。
 * 灰度图 rNN.gray.png 和网页里一样取 RGB 三个通道里最亮的（detectInImage），用 Python 生成：
 *   python -I local/eval/make-gray.py
 * 门槛见文件末尾 TARGET，改 raster.ts 前后都跑：npx vitest run tests/raster-real.test.ts --silent=false
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectPlan, type Detection, type PxWall } from "../src/model/raster";
import { pointInPolygon } from "../src/model/geometry";
import { sampledIoU } from "../src/model/fuse";
import type { Vec2 } from "../src/model/schema";
import { pngGray } from "./png";

interface Case { name: string; image: string; check?: { scale: [number, number]; rooms?: [string, string, number, number][] } }
type TWall = [number, number, number, number, number, ...string[]];
interface Truth { walls: TWall[]; openings: [string, number, number, number, number][]; rooms: [string, string, Vec2[]][] }

const CASES = "local/eval/cases.json";
const cases: Case[] = existsSync(CASES) ? JSON.parse(readFileSync(CASES, "utf8")).filter((c: Case) => /^r\d+$/.test(c.name)) : [];

const horiz = (a: Vec2, b: Vec2) => Math.abs(b[1] - a[1]) <= Math.abs(b[0] - a[0]);
/** 真墙（中线 a→b）被 cands 里平行、中线距离 ≤ tol 的段盖住的长度比例 */
function coverage(a: Vec2, b: Vec2, cands: { a: Vec2; b: Vec2 }[], tol: number): number {
  const h = horiz(a, b), c = h ? (a[1] + b[1]) / 2 : (a[0] + b[0]) / 2;
  const lo = h ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]), hi = h ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
  const spans = cands.filter(s => horiz(s.a, s.b) === h && Math.abs((h ? (s.a[1] + s.b[1]) / 2 : (s.a[0] + s.b[0]) / 2) - c) <= tol)
    .map(s => [Math.max(lo, h ? Math.min(s.a[0], s.b[0]) : Math.min(s.a[1], s.b[1])), Math.min(hi, h ? Math.max(s.a[0], s.b[0]) : Math.max(s.a[1], s.b[1]))])
    .filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
  let cov = 0, cur = -Infinity;
  for (const [x, y] of spans) { if (y > cur) { cov += y - Math.max(x, cur); cur = y; } }
  return hi > lo ? cov / (hi - lo) : 0;
}

export interface RealScore {
  walls?: { truth: number; covered: number; extra: number };
  gaps?: { truth: number; found: number; windowOk: number; extra: number };
  rooms?: { truth: number; found: number };
  points?: { truth: number; inRoom: number; distinct: number };
  ms: number;
}

export function scoreReal(det: Detection, scale: number, truth: Truth | null, points: [string, string, number, number][]): Omit<RealScore, "ms"> {
  const out: Omit<RealScore, "ms"> = {};
  if (truth) {
    const tw = truth.walls.map(w => ({ a: [w[0], w[1]] as Vec2, b: [w[2], w[3]] as Vec2 }));
    const segs = [...det.walls, ...det.gaps];
    out.walls = {
      truth: tw.length,
      covered: tw.filter(w => coverage(w.a, w.b, segs, Math.max(3, 0.1 * scale)) >= 0.8).length,
      // 多出来的墙：比两倍墙厚长、而且 0.3 m 内没有平行的真墙
      extra: det.walls.filter((w: PxWall) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) >= 2 * det.wallThickness && coverage(w.a, w.b, tw, 0.3 * scale) < 0.5).length,
    };
    const center = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const gc = det.gaps.map(g => ({ c: center(g.a, g.b), kind: g.kind, used: false }));
    let found = 0, windowOk = 0;
    for (const [type, x1, y1, x2, y2] of truth.openings) {
      const c = center([x1, y1], [x2, y2]);
      const g = gc.filter(g => !g.used && Math.hypot(g.c[0] - c[0], g.c[1] - c[1]) <= 0.4 * scale).sort((p, q) => Math.hypot(p.c[0] - c[0], p.c[1] - c[1]) - Math.hypot(q.c[0] - c[0], q.c[1] - c[1]))[0];
      if (!g) continue;
      g.used = true; found++;
      if ((type === "window") === (g.kind === "window")) windowOk++;
    }
    out.gaps = { truth: truth.openings.length, found, windowOk, extra: gc.filter(g => !g.used).length };
    out.rooms = { truth: truth.rooms.length, found: truth.rooms.filter(([, , poly]) => det.rooms.some(r => sampledIoU(poly, r.polygon) >= 0.5)).length };
  }
  if (points.length) {
    const at = points.map(([, type, x, y]) => ({ type, i: det.rooms.findIndex(r => pointInPolygon([x, y], r.polygon)) }));
    const pub = (t: string) => t === "living" || t === "dining";
    // 不同的房间点落在同一个检测房间里（客厅、餐厅除外）：这几个点都不算
    const distinct = at.filter((p, k) => p.i >= 0 && !at.some((q, j) => j !== k && q.i === p.i && !(pub(p.type) && pub(q.type)))).length;
    out.points = { truth: points.length, inRoom: at.filter(p => p.i >= 0).length, distinct };
  }
  return out;
}

const results: Record<string, RealScore> = {};
describe.skipIf(!cases.length)("真实户型图：像素检测", () => {
  for (const c of cases) {
    const gray = `local/eval/real/${c.name}.gray.png`, truthPath = `local/eval/real/${c.name}.truth.snapped.json`;
    it.skipIf(!existsSync(gray) || !c.check)(c.name, () => {
      const img = pngGray(gray);
      const t0 = performance.now();
      const det = detectPlan(img);
      const ms = performance.now() - t0;
      const truth: Truth | null = existsSync(truthPath) ? JSON.parse(readFileSync(truthPath, "utf8")) : null;
      results[c.name] = { ...scoreReal(det, (c.check!.scale[0] + c.check!.scale[1]) / 2, truth, c.check!.rooms ?? []), ms: Math.round(ms) };
      const r = results[c.name];
      console.log(`${c.name} 墙厚 ${det.wallThickness}px 墙 ${det.walls.length} 洞口 ${det.gaps.length} 房间 ${det.rooms.length}（${r.ms} ms）`
        + (r.walls ? ` | 墙覆盖 ${r.walls.covered}/${r.walls.truth} 多 ${r.walls.extra} | 洞口 ${r.gaps!.found}/${r.gaps!.truth}（窗/非窗对 ${r.gaps!.windowOk}，多 ${r.gaps!.extra}）| 房间 ${r.rooms!.found}/${r.rooms!.truth}` : "")
        + (r.points ? ` | 房间点 ${r.points.distinct}/${r.points.truth}（落在房间里 ${r.points.inRoom}）` : ""));
      const T = TARGET[c.name];
      if (!T) return;
      if (T.walls != null) expect(r.walls!.covered).toBeGreaterThanOrEqual(T.walls);
      if (T.extra != null) expect(r.walls!.extra).toBeLessThanOrEqual(T.extra);
      if (T.gaps != null) expect(r.gaps!.found).toBeGreaterThanOrEqual(T.gaps);
      if (T.rooms != null) expect(r.rooms!.found).toBeGreaterThanOrEqual(T.rooms);
      if (T.points != null) expect(r.points!.distinct).toBeGreaterThanOrEqual(T.points);
      expect(r.ms).toBeLessThan(2000);
    });
  }
});

/** 门槛：改检测时只许往上调（数字是实测达到的，不是愿望） */
const TARGET: Record<string, { walls?: number; extra?: number; gaps?: number; rooms?: number; points?: number }> = {
  r01: { walls: 20, extra: 2, gaps: 13, rooms: 8, points: 8 },
  r02: { points: 7 },
  r03: { walls: 18, extra: 2, gaps: 14, rooms: 8, points: 8 },
  r04: { walls: 19, extra: 2, gaps: 10, rooms: 7, points: 6 },
  r05: { points: 11 },
  r06: { points: 3 },
  r07: { points: 9 },
  r08: { points: 7 },
  r10: { points: 9 },
};
