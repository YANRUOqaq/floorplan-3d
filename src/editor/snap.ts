/**
 * 描图时的吸附：鼠标点下去的位置往“应该在的地方”靠。
 * 优先级：已有的墙端点和房间顶点 > 对齐已有端点的 x 或 z（出一条辅助线）> 和上一个点保持水平或竖直 > 1 cm 网格。
 * 全部是纯函数，tol 用米表示（调用方把屏幕上的像素容差换算成米）。
 */
import type { House, Vec2 } from "../model/schema";
import { wallFrame } from "../model/geometry";

export interface SnapResult { p: Vec2; kind: "point" | "align" | "ortho" | "wall" | "grid"; guides: [Vec2, Vec2][] }

export function snapTargets(h: House, exclude: Set<Vec2> = new Set()): Vec2[] {
  const pts: Vec2[] = [];
  for (const w of h.walls) for (const p of [w.a, w.b]) if (!exclude.has(p)) pts.push(p);
  for (const r of h.rooms) for (const p of r.polygon) if (!exclude.has(p)) pts.push(p);
  return pts;
}

const round = (v: number, step: number) => Math.round(v / step) * step;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * @param raw     鼠标位置（米）
 * @param targets 可以吸附的点
 * @param anchor  上一个点（画墙、画房间时），用来保持水平竖直
 * @param tol     吸附距离（米）
 * @param free    按住 Shift：不做水平竖直和对齐，只吸附端点和网格
 */
export function snap(raw: Vec2, targets: Vec2[], anchor: Vec2 | null, tol: number, free = false, grid = 0.01): SnapResult {
  // 1. 端点
  let best: Vec2 | null = null, bd = tol;
  for (const t of targets) { const d = Math.hypot(t[0] - raw[0], t[1] - raw[1]); if (d < bd) { bd = d; best = t; } }
  if (best) return { p: [best[0], best[1]], kind: "point", guides: [] };
  let x = raw[0], z = raw[1];
  const guides: [Vec2, Vec2][] = [];
  let kind: SnapResult["kind"] = "grid";
  let lockX = false, lockZ = false;
  if (!free) {
    // 2. 和上一个点水平或竖直（角度在 8° 以内）
    if (anchor) {
      const dx = x - anchor[0], dz = z - anchor[1], ang = Math.abs(Math.atan2(dz, dx));
      const lim = 8 * Math.PI / 180;
      if (ang < lim || Math.PI - ang < lim) { z = anchor[1]; lockZ = true; kind = "ortho"; }
      else if (Math.abs(ang - Math.PI / 2) < lim) { x = anchor[0]; lockX = true; kind = "ortho"; }
    }
    // 3. 对齐别的端点的 x 或 z
    let ax: Vec2 | null = null, az: Vec2 | null = null, bx = tol, bz = tol;
    for (const t of targets) {
      if (!lockX && Math.abs(t[0] - x) < bx) { bx = Math.abs(t[0] - x); ax = t; }
      if (!lockZ && Math.abs(t[1] - z) < bz) { bz = Math.abs(t[1] - z); az = t; }
    }
    if (ax) { x = ax[0]; lockX = true; kind = "align"; }
    if (az) { z = az[1]; lockZ = true; kind = "align"; }
    if (ax) guides.push([ax, [x, z]]);
    if (az) guides.push([az, [x, z]]);
  }
  if (!lockX) x = round(x, grid);
  if (!lockZ) z = round(z, grid);
  return { p: [r4(x), r4(z)], kind, guides };
}

/** 离鼠标最近的墙（中心线距离小于 墙厚/2 + tol），返回墙和沿墙的位置 u */
export function nearestWall(h: House, p: Vec2, tol: number) {
  let best: { id: string; u: number; dist: number } | null = null;
  for (const w of h.walls) {
    const { len, d, n } = wallFrame(w);
    const rx = p[0] - w.a[0], rz = p[1] - w.a[1];
    const u = rx * d[0] + rz * d[1], q = Math.abs(rx * n[0] + rz * n[1]);
    if (u < -tol || u > len + tol) continue;
    const dist = q;
    if (dist <= w.thickness / 2 + tol && (!best || dist < best.dist)) best = { id: w.id, u: Math.max(0, Math.min(len, u)), dist };
  }
  return best;
}

/** 在墙上放一个宽 width 的洞口，中心尽量对准 u，不超出墙 */
export function placeOnWall(len: number, u: number, width: number) {
  const w = Math.min(width, Math.max(0.3, len - 0.1));
  const offset = Math.max(0, Math.min(len - w, u - w / 2));
  return { offset: r4(round(offset, 0.01)), width: r4(w) };
}
