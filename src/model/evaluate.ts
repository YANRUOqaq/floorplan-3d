/**
 * 户型识别的评测：把识别结果和人工描好的标准答案比，给出几项固定指标。
 * 改识别方法前后都用同一套指标、同一批图，才能说“准了多少”（见 tools/eval.html）。
 *
 * 指标：
 * - 墙：标准答案里的每面墙，有没有识别出的墙和它平行、中线距离在 10 cm（和 30 cm）以内、并且盖住它 80% 以上的长度。
 *   识别出的墙可以拆成几段，只看覆盖，不看段数。另外统计识别出、但对不上任何真墙的“多出来的墙”。
 * - 门窗：标准答案里每个门窗的中心，40 cm 内有没有识别出同类的（门类：平开门、入户门、推拉门、门洞；窗类：窗）。
 * - 房间：和标准答案的房间重合度（交并比）≥ 0.5 算找到，再看类型对不对。
 *
 * 坐标原点是随便定的（识别结果从哪儿算起都行），所以先找一个平移把两边对齐，再比。
 * 不对齐缩放：比例错了就是识别错了，要算进指标里。
 */
import type { House, Opening, Room, Vec2, Wall } from "./schema";
import { bbox, pointInPolygon, wallFrame, openingCenter } from "./geometry";

type Plan = Pick<House, "walls" | "rooms">;

export interface PlanScore {
  /** 应用到识别结果上的平移（米），对齐后再比 */
  offset: Vec2;
  walls: { truth: number; within10: number; within30: number; found: number; extra: number };
  openings: { truth: number; found: number; sameType: number; extra: number };
  rooms: { truth: number; found: number; sameType: number; extra: number };
}

const ANGLE_TOL = Math.sin(5 * Math.PI / 180);

/** 墙 t 被 cands 里平行、距离在 tol 内的墙盖住了多少比例（沿 t 的方向投影后求并集） */
export function wallCoverage(t: Wall, cands: Wall[], tol: number): number {
  const { len, d, n } = wallFrame(t);
  if (len < 1e-6) return 0;
  const spans: [number, number][] = [];
  for (const c of cands) {
    const f = wallFrame(c);
    if (Math.abs(f.d[0] * n[0] + f.d[1] * n[1]) > ANGLE_TOL) continue;   // 不平行
    const rel = (p: Vec2) => [(p[0] - t.a[0]) * d[0] + (p[1] - t.a[1]) * d[1], (p[0] - t.a[0]) * n[0] + (p[1] - t.a[1]) * n[1]];
    const [ua, va] = rel(c.a), [ub, vb] = rel(c.b);
    if (Math.max(Math.abs(va), Math.abs(vb)) > tol) continue;             // 离得太远
    const lo = Math.max(0, Math.min(ua, ub)), hi = Math.min(len, Math.max(ua, ub));
    if (hi > lo) spans.push([lo, hi]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0, curLo = -1, curHi = -1;
  for (const [lo, hi] of spans) {
    if (lo > curHi) { covered += curHi - curLo; curLo = lo; curHi = hi; }
    else curHi = Math.max(curHi, hi);
  }
  covered += curHi - curLo;
  return covered / len;
}

const shiftWall = (w: Wall, o: Vec2): Wall => ({ ...w, a: [w.a[0] + o[0], w.a[1] + o[1]], b: [w.b[0] + o[0], w.b[1] + o[1]] });
const shiftRoom = (r: Room, o: Vec2): Room => ({ ...r, polygon: r.polygon.map(p => [p[0] + o[0], p[1] + o[1]] as Vec2) });

/** 有多少面真墙被盖住 80% 以上 */
function countCovered(truth: Wall[], got: Wall[], tol: number) {
  return truth.filter(t => wallCoverage(t, got, tol) >= 0.8).length;
}

/**
 * 找对齐用的平移：候选是“某个识别出的墙端点 → 某个真墙端点”的平移，
 * 取让最多真墙在 30 cm 内被盖住的那个；同分取盖住总长度最大的。
 */
export function bestOffset(truth: Wall[], got: Wall[]): Vec2 {
  if (!truth.length || !got.length) return [0, 0];
  const tp = truth.flatMap(w => [w.a, w.b]), gp = got.flatMap(w => [w.a, w.b]);
  const seen = new Set<string>();
  let best: Vec2 = [0, 0], bestScore = -1;
  for (const p of gp) for (const q of tp) {
    const o: Vec2 = [Math.round((q[0] - p[0]) * 100) / 100, Math.round((q[1] - p[1]) * 100) / 100];
    const key = o.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const moved = got.map(w => shiftWall(w, o));
    const score = truth.reduce((s, t) => { const c = wallCoverage(t, moved, 0.3); return s + (c >= 0.8 ? 1000 : 0) + c; }, 0);
    if (score > bestScore) { bestScore = score; best = o; }
  }
  return best;
}

const DOORS = new Set<Opening["type"]>(["door", "entry", "sliding", "opening"]);
const allOpenings = (walls: Wall[]) => walls.flatMap(w => w.openings.map(o => ({ o, c: openingCenter(w, o), door: DOORS.has(o.type) })));

/** 两个多边形的交并比：在 5 cm 的格点上数（房间都只有几米大，够准也够快） */
export function polygonIoU(A: Vec2[], B: Vec2[], step = 0.05): number {
  const a = bbox(A), b = bbox(B);
  const x0 = Math.min(a.x0, b.x0), x1 = Math.max(a.x1, b.x1), z0 = Math.min(a.z0, b.z0), z1 = Math.max(a.z1, b.z1);
  if (a.x1 <= b.x0 || b.x1 <= a.x0 || a.z1 <= b.z0 || b.z1 <= a.z0) return 0;
  let inter = 0, uni = 0;
  for (let x = x0 + step / 2; x < x1; x += step) for (let z = z0 + step / 2; z < z1; z += step) {
    const p: Vec2 = [x, z], ia = pointInPolygon(p, A), ib = pointInPolygon(p, B);
    if (ia && ib) inter++;
    if (ia || ib) uni++;
  }
  return uni ? inter / uni : 0;
}

export function scorePlan(got: Plan, truth: Plan): PlanScore {
  const offset = bestOffset(truth.walls, got.walls);
  const gw = got.walls.map(w => ({ ...shiftWall(w, offset), openings: w.openings }));
  const gr = got.rooms.map(r => shiftRoom(r, offset));

  // 墙
  const within10 = countCovered(truth.walls, gw, 0.1), within30 = countCovered(truth.walls, gw, 0.3);
  const extra = gw.filter(g => wallCoverage(g, truth.walls, 0.3) < 0.5).length;

  // 门窗：一对一配对，近的先配
  const to = allOpenings(truth.walls), go = allOpenings(gw);
  const pairs: { i: number; j: number; d: number }[] = [];
  to.forEach((t, i) => go.forEach((g, j) => { const d = Math.hypot(t.c[0] - g.c[0], t.c[1] - g.c[1]); if (d <= 0.4 && t.door === g.door) pairs.push({ i, j, d }); }));
  pairs.sort((p, q) => p.d - q.d);
  const usedT = new Set<number>(), usedG = new Set<number>();
  let sameTypeO = 0;
  for (const p of pairs) {
    if (usedT.has(p.i) || usedG.has(p.j)) continue;
    usedT.add(p.i); usedG.add(p.j);
    if (to[p.i].o.type === go[p.j].o.type) sameTypeO++;
  }

  // 房间：一对一配对，重合度高的先配
  const rp: { i: number; j: number; iou: number }[] = [];
  truth.rooms.forEach((t, i) => gr.forEach((g, j) => { const iou = polygonIoU(t.polygon, g.polygon); if (iou >= 0.5) rp.push({ i, j, iou }); }));
  rp.sort((p, q) => q.iou - p.iou);
  const rT = new Set<number>(), rG = new Set<number>();
  let sameTypeR = 0;
  for (const p of rp) {
    if (rT.has(p.i) || rG.has(p.j)) continue;
    rT.add(p.i); rG.add(p.j);
    if (truth.rooms[p.i].type === gr[p.j].type) sameTypeR++;
  }

  return {
    offset,
    walls: { truth: truth.walls.length, within10, within30, found: gw.length, extra },
    openings: { truth: to.length, found: usedT.size, sameType: sameTypeO, extra: go.length - usedG.size },
    rooms: { truth: truth.rooms.length, found: rT.size, sameType: sameTypeR, extra: gr.length - rG.size },
  };
}
