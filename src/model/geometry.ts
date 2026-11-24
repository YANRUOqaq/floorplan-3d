/**
 * 纯几何计算，不依赖 three.js，方便写单元测试。
 * 3D 生成、2D 编辑器、家具摆放检查都用这里的函数。
 */
import type { House, Item, Opening, Room, Vec2, Wall } from "./schema";

/* ---------- 多边形 ---------- */
export function signedArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    s += x0 * z1 - x1 * z0;
  }
  return s / 2;
}
export const polygonArea = (poly: Vec2[]) => Math.abs(signedArea(poly));

export function centroid(poly: Vec2[]): Vec2 {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-9) {
    const n = poly.length;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    const f = x0 * z1 - x1 * z0;
    cx += (x0 + x1) * f; cz += (z0 + z1) * f;
  }
  return [cx / (6 * a), cz / (6 * a)];
}

/** 射线法；正好压在边上的点结果不确定，调用方别依赖 */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < (xj - xi) * (p[1] - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function bbox(points: Vec2[]): { x0: number; x1: number; z0: number; z1: number } {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0, x1, z0, z1 };
}

/** 房间标签放的位置：质心在房间里就用质心（L 形房间可能不在），否则取房间里离质心最近的格点 */
export function labelPoint(poly: Vec2[]): Vec2 {
  const c = centroid(poly);
  if (pointInPolygon(c, poly)) return c;
  const b = bbox(poly);
  let best: Vec2 = c, bd = Infinity;
  for (let i = 1; i < 20; i++) for (let j = 1; j < 20; j++) {
    const p: Vec2 = [b.x0 + (b.x1 - b.x0) * i / 20, b.z0 + (b.z1 - b.z0) * j / 20];
    const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
    if (d < bd && pointInPolygon(p, poly) && distToPolygonEdge(p, poly) > 0.3) { bd = d; best = p; }
  }
  return best;
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}
export function distToPolygonEdge(p: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

export function roomAt(rooms: Room[], p: Vec2): Room | undefined {
  return rooms.find(r => pointInPolygon(p, r.polygon));
}

/* ---------- 墙 ---------- */
/** 墙的局部坐标系：沿墙方向 d（a→b），法线 n 是沿 a→b 看的左手边 */
export function wallFrame(w: Wall) {
  const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], len = Math.hypot(dx, dz);
  const d: Vec2 = [dx / len, dz / len];
  const n: Vec2 = [d[1], -d[0]];
  return { len, d, n };
}
/** 墙局部坐标 (沿墙距离 u, 垂直墙距离 p) → 世界坐标 */
export function wallPoint(w: Wall, u: number, p = 0): Vec2 {
  const { d, n } = wallFrame(w);
  return [w.a[0] + d[0] * u + n[0] * p, w.a[1] + d[1] * u + n[1] * p];
}
export const openingCenter = (w: Wall, o: Opening, p = 0) => wallPoint(w, o.offset + o.width / 2, p);

/** 实心墙段 [沿墙起, 止, 下沿, 上沿]：按洞口把整面墙切开（窗下、门上的部分也算） */
export function wallPieces(w: Wall, H: number): [number, number, number, number][] {
  const { len } = wallFrame(w);
  const pieces: [number, number, number, number][] = [];
  let cur = 0;
  for (const o of [...w.openings].sort((u, v) => u.offset - v.offset)) {
    const a = o.offset, b = o.offset + o.width;
    if (a > cur) pieces.push([cur, a, 0, H]);
    if (o.bottom > 0) pieces.push([a, b, 0, o.bottom]);
    if (o.top < H) pieces.push([a, b, o.top, H]);
    cur = Math.max(cur, b);
  }
  if (len > cur) pieces.push([cur, len, 0, H]);
  return pieces;
}

/** 墙要在哪些位置切段：房间多边形的顶点落在这面墙上的位置（两侧房间不同，墙面材质也不同） */
export function wallSplits(w: Wall, rooms: Room[]): number[] {
  const { len, d, n } = wallFrame(w);
  const tol = w.thickness / 2 + 0.06;
  const out = new Set<number>();
  for (const r of rooms) for (const [x, z] of r.polygon) {
    const rx = x - w.a[0], rz = z - w.a[1];
    const u = rx * d[0] + rz * d[1], p = rx * n[0] + rz * n[1];
    if (Math.abs(p) <= tol && u > 1e-6 && u < len - 1e-6) out.add(Math.round(u * 1e4) / 1e4);
  }
  return [...out].sort((a, b) => a - b);
}

/* ---------- 家具 ---------- */
/** rot（度）→ 本地 x 轴和正面方向在世界里的朝向。和 three.js 的 rotation.y 一致 */
export function itemAxes(rotDeg: number) {
  const t = rotDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return { ax: [c, -s] as Vec2, front: [s, c] as Vec2 };
}
/** 家具占地的四个角（世界坐标），顺序：左后、右后、右前、左前（从正面看） */
export function itemFootprint(it: Pick<Item, "pos" | "rot" | "size">): Vec2[] {
  const { ax, front } = itemAxes(it.rot);
  const hw = it.size[0] / 2, hd = it.size[1] / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) =>
    [it.pos[0] + ax[0] * u + front[0] * v, it.pos[1] + ax[1] * u + front[1] * v] as Vec2);
}

/** 两个凸多边形是否相交（分离轴定理），用来查家具重叠 */
export function convexOverlap(A: Vec2[], B: Vec2[], eps = 1e-3): boolean {
  for (const P of [A, B]) for (let i = 0; i < P.length; i++) {
    const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % P.length];
    const nx = z1 - z0, nz = x0 - x1, L = Math.hypot(nx, nz) || 1;
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const [x, z] of A) { const v = (x * nx + z * nz) / L; aMin = Math.min(aMin, v); aMax = Math.max(aMax, v); }
    for (const [x, z] of B) { const v = (x * nx + z * nz) / L; bMin = Math.min(bMin, v); bMax = Math.max(bMax, v); }
    if (aMax <= bMin + eps || bMax <= aMin + eps) return false;
  }
  return true;
}

/* ---------- 能不能走 ---------- */
const PASSABLE = new Set(["door", "opening", "sliding"]);
/** 人离墙中心线至少要多远：墙厚一半 + 这个值 */
export const BODY_MARGIN = 0.2;

export interface Blocker { r: [number, number, number, number]; active?: () => boolean }

/**
 * 能站的地方 = 在某个房间里（或在能通过的门洞里），并且离所有落地的实心墙段都有一定距离。
 * 家具占地（blockers）由 3D 部分按包围盒算好传进来。
 */
export function makeWalkable(house: House) {
  const H = house.height;
  const solids: { a: Vec2; b: Vec2; r: number }[] = [];
  const doors: { w: Wall; o: Opening }[] = [];
  for (const w of house.walls) {
    for (const [u0, u1, y0] of wallPieces(w, w.height ?? H)) if (y0 === 0) solids.push({ a: wallPoint(w, u0), b: wallPoint(w, u1), r: w.thickness / 2 + BODY_MARGIN });
    for (const o of w.openings) {
      if (PASSABLE.has(o.type) && o.bottom < 0.05) doors.push({ w, o });
      else if (o.bottom < 0.05) solids.push({ a: wallPoint(w, o.offset), b: wallPoint(w, o.offset + o.width), r: w.thickness / 2 + BODY_MARGIN });
    }
  }
  const inDoor = (p: Vec2) => doors.some(({ w, o }) => {
    const { d, n } = wallFrame(w), rx = p[0] - w.a[0], rz = p[1] - w.a[1];
    const u = rx * d[0] + rz * d[1], q = rx * n[0] + rz * n[1];
    return u > o.offset + 0.1 && u < o.offset + o.width - 0.1 && Math.abs(q) <= w.thickness / 2 + BODY_MARGIN + 0.05;
  });
  return (x: number, z: number, blockers: Blocker[] = []) => {
    const p: Vec2 = [x, z];
    if (!house.rooms.some(r => pointInPolygon(p, r.polygon)) && !inDoor(p)) return false;
    for (const s of solids) if (distToSegment(p, s.a, s.b) < s.r) return false;
    for (const b of blockers) if ((!b.active || b.active()) && x >= b.r[0] && x <= b.r[1] && z >= b.r[2] && z <= b.r[3]) return false;
    return true;
  };
}

/** 每个房间的门（能走过去的洞口）和它通向的房间 */
export function roomDoors(house: House, room: Room) {
  const out: { w: Wall; o: Opening; inward: Vec2 }[] = [];
  for (const w of house.walls) for (const o of w.openings) {
    if (!PASSABLE.has(o.type) && o.type !== "entry") continue;
    const { n } = wallFrame(w);
    for (const sg of [1, -1]) {
      const p = openingCenter(w, o, sg * (w.thickness / 2 + 0.3));
      if (pointInPolygon(p, room.polygon)) out.push({ w, o, inward: [n[0] * sg, n[1] * sg] });
    }
  }
  return out;
}

/**
 * 自动生成“站到某个房间”的视角，学拍房子的站法：站在一个墙角，看向对角。
 * 候选位置是每个墙角往房间里收 0.45 m（站不了就再往中间挪）；按“对角看得远”打分，
 * 离室内门近的角加分（像刚走进房间），通往阳台的门不算。都站不了就站在房间中间。
 */
export function autoRoomView(house: House, room: Room, walkable: (x: number, z: number) => boolean): { at: Vec2; look: [number, number, number] } {
  const c = labelPoint(room.polygon);
  const doorPts = roomDoors(house, room)
    .filter(d => d.o.type !== "entry" && d.o.type !== "window")
    .filter(d => {   // 只算通往室内正经房间的门：另一侧是阳台、飘窗这类小空间的不算
      const oc = openingCenter(d.w, d.o), k = d.w.thickness / 2 + 0.3;
      const other = roomAt(house.rooms, [oc[0] - d.inward[0] * k, oc[1] - d.inward[1] * k]);
      return !!other && !other.outdoor && polygonArea(other.polygon) >= 2;
    })
    .map(d => openingCenter(d.w, d.o));
  let best: { at: Vec2; score: number } | null = null;
  for (const v of room.polygon) {
    const L = Math.hypot(c[0] - v[0], c[1] - v[1]) || 1;
    let at: Vec2 = [v[0] + (c[0] - v[0]) / L * 0.45 * Math.SQRT2, v[1] + (c[1] - v[1]) / L * 0.45 * Math.SQRT2];
    for (let k = 0; k < 6 && !walkable(at[0], at[1]); k++) at = [at[0] + (c[0] - at[0]) * 0.2, at[1] + (c[1] - at[1]) * 0.2];
    if (!walkable(at[0], at[1]) || !pointInPolygon(at, room.polygon)) continue;
    const far = Math.max(...room.polygon.map(q => Math.hypot(q[0] - at[0], q[1] - at[1])));
    const nearDoor = doorPts.length ? Math.min(...doorPts.map(p => Math.hypot(p[0] - at[0], p[1] - at[1]))) : 3;
    const score = far - 0.3 * Math.min(nearDoor, 3);
    if (!best || score > best.score) best = { at, score };
  }
  const at = best?.at ?? c;
  let far = room.polygon[0], fd = -1;
  for (const v of room.polygon) { const d = Math.hypot(v[0] - at[0], v[1] - at[1]); if (d > fd) { fd = d; far = v; } }
  const look: [number, number, number] = [far[0] * 0.7 + c[0] * 0.3, 1.0, far[1] * 0.7 + c[1] * 0.3];
  return { at, look };
}

export function houseBBox(house: House) {
  const pts: Vec2[] = [];
  for (const w of house.walls) pts.push(w.a, w.b);
  for (const r of house.rooms) pts.push(...r.polygon);
  if (!pts.length) return { x0: 0, x1: 4, z0: 0, z1: 4 };
  return bbox(pts);
}
