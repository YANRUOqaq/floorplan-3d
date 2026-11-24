/**
 * 墙、门、窗。从原 01 房页面的 buildWalls / fillOpening 移植，推广到任意方向的墙：
 * 每面墙放在自己的局部坐标系里建模（u 沿墙，y 向上，p 垂直墙、指向沿 a→b 看的左手边），
 * 再整体平移旋转到世界坐标。原页面只支持横平竖直的墙，是这里的特例。
 */
import * as THREE from "three";
import type { House, Opening, Wall } from "../model/schema";
import { roomAt, wallFrame, wallPieces, wallPoint, wallSplits } from "../model/geometry";
import type { Materials } from "./materials";
import { roomWallMat } from "./materials";
import { box, type BoxOpts } from "./prims";

/** 鸟瞰时把墙切到这个高度，能看见屋里 */
export const H_CUT = 1.05;

type PFn = (m: THREE.Material | THREE.Material[], a0: number, a1: number, y0: number, y1: number, p0: number, p1: number, o?: BoxOpts) => THREE.Mesh | null;

/**
 * 墙的局部坐标系：group 放在墙的 a 端，rotation.y 让本地 x 轴对准 a→b。
 * 旋转后本地 +z 指向 -p（右手边），所以 p 换成本地 z 时要取负。
 */
function wallGroup(w: Wall) {
  const { d } = wallFrame(w);
  const g = new THREE.Group();
  g.position.set(w.a[0], 0, w.a[1]);
  g.rotation.y = Math.atan2(-d[1], d[0]);
  return g;
}
function makeP(g: THREE.Group, w: Wall, Hc: number): PFn {
  const { d } = wallFrame(w);
  const uvOff = w.a[0] * d[0] + w.a[1] * d[1];   // 瓷砖缝按世界坐标对齐
  return (m, a0, a1, y0, y1, p0, p1, o = {}) => {
    if (y0 >= Hc) return null;
    y1 = Math.min(y1, Hc);
    const q0 = Math.min(p0, p1), q1 = Math.max(p0, p1);
    return box(m, a0, a1, y0, y1, -q1, -q0, g, Object.assign({ uvOff }, o));
  };
}

export function buildWalls(house: House, m: Materials, cut: boolean): THREE.Group {
  const root = new THREE.Group();
  const { mat } = m;
  for (const w of house.walls) {
    const g = wallGroup(w), { len } = wallFrame(w), t = w.thickness;
    const H = w.height ?? house.height;
    const Hc = cut ? Math.min(H_CUT, H) : H;
    const P = makeP(g, w, Hc);
    // 墙底下补一段地基，鸟瞰时侧面不露缝
    box(mat.base, 0, len, -0.12, -0.002, -t / 2, t / 2, g, { shadow: false });

    if (w.kind === "parapet") {
      P(mat.ext, 0, len, 0, H, -t / 2, t / 2);
    } else if (w.kind === "railing") {
      const solid = Math.min(0.5, H);
      P(mat.ext, 0, len, 0, solid, -t / 2, t / 2);
      P(mat.frame, 0.1, len - 0.1, H - 0.04, H, -0.03, 0.03, { r: 0.008 });
      for (let u = 0.15; u < len - 0.1; u += 0.12) P(mat.frame, u, u + 0.016, solid, H - 0.04, -0.008, 0.008);
    } else {
      const splits = wallSplits(w, house.rooms);
      for (const [a0, a1, y0, y1] of wallPieces(w, H)) {
        const cuts = [a0, ...splits.filter(v => v > a0 + 1e-6 && v < a1 - 1e-6), a1];
        for (let i = 0; i < cuts.length - 1; i++) {
          const b0 = cuts[i], b1 = cuts[i + 1], yt = Math.min(y1, Hc);
          if (y0 >= Hc) continue;
          const mid = (b0 + b1) / 2, off = t / 2 + 0.03;
          const rP = roomAt(house.rooms, wallPoint(w, mid, off)), rN = roomAt(house.rooms, wallPoint(w, mid, -off));
          const top = cut && yt === Hc ? mat.cutTop : mat.paint;
          // BoxGeometry 的面顺序：+x, -x, +y, -y, +z, -z；本地 +z 朝 -p，本地 -z 朝 +p
          const mats = [mat.paint, mat.paint, top, mat.paint, roomWallMat(m, house, rN), roomWallMat(m, house, rP)];
          P(mats, b0, b1, y0, yt, -t / 2, t / 2, { fixed: true });
          if (y0 === 0) for (const [r, sg] of [[rP, 1], [rN, -1]] as const) {
            if (!r || r.outdoor || r.wall !== "paint") continue;
            P(mat.skirting, b0, b1, 0, 0.08, sg * t / 2, sg * (t / 2 + 0.012), { shadow: false });
          }
        }
      }
      for (const o of w.openings) fillOpening(house, w, o, P, m);
    }
    root.add(g);
  }
  return root;
}

/** 门套、门板、推拉门、窗框、窗台石和护栏。坐标都是墙的局部坐标 (u, y, p) */
function fillOpening(house: House, w: Wall, o: Opening, P: PFn, m: Materials) {
  const { mat } = m, t = w.thickness;
  const a = o.offset, b = o.offset + o.width, wd = o.width;
  // 室内在哪一侧：+p 那边是室内房间就是 1，否则 -1
  const rP = roomAt(house.rooms, wallPoint(w, (a + b) / 2, t / 2 + 0.05));
  const inside = rP && !rP.outdoor ? 1 : -1;

  if (o.type === "door" || o.type === "entry") {
    const dm = o.type === "entry" ? mat.entry : mat.door;
    for (const sg of [1, -1]) {   // 门套线
      P(dm, a - 0.07, a, 0, o.top + 0.07, sg * t / 2, sg * (t / 2 + 0.015), { r: 0.004 });
      P(dm, b, b + 0.07, 0, o.top + 0.07, sg * t / 2, sg * (t / 2 + 0.015), { r: 0.004 });
      P(dm, a - 0.07, b + 0.07, o.top, o.top + 0.07, sg * t / 2, sg * (t / 2 + 0.015), { r: 0.004 });
    }
    P(dm, a, a + 0.015, 0, o.top, -t / 2, t / 2); P(dm, b - 0.015, b, 0, o.top, -t / 2, t / 2); P(dm, a, b, o.top - 0.015, o.top, -t / 2, t / 2);
    if (o.type === "entry") {   // 入户门关着
      P(dm, a + 0.015, b - 0.015, 0.01, o.top - 0.015, -0.03, 0.03, { r: 0.004 });
      for (const [y0, y1] of [[0.2, 0.95], [1.12, 1.9]]) for (const sg of [1, -1]) P(mat.frame, a + 0.13, b - 0.13, y0, Math.min(y1, o.top - 0.12), sg * 0.03, sg * 0.034, { r: 0.002 });
      const hx = (o.hinge ?? "a") === "a" ? b - 0.12 : a + 0.09;
      for (const sg of [1, -1]) P(mat.steel, hx, hx + 0.03, 0.9, 1.2, sg * 0.034, sg * 0.06, { r: 0.008 });
      return;
    }
    // 平开门开到 90°，带两块门芯和把手
    const sw = o.side ?? 1;
    const hA = (o.hinge ?? "a") === "a" ? a + 0.02 : b - 0.06;
    const pIn = sw > 0 ? t / 2 : -t / 2, pOut = sw > 0 ? t / 2 + wd - 0.03 : -t / 2 - wd + 0.03;
    P(dm, hA, hA + 0.04, 0.01, o.top - 0.01, pIn, pOut, { r: 0.004 });
    const pa = pIn + (pOut - pIn) * 0.14, pb = pIn + (pOut - pIn) * 0.86;
    for (const [y0, y1] of [[0.2, 0.95], [1.12, 1.88]]) {
      P(mat.doorPanel, hA - 0.004, hA, y0, Math.min(y1, o.top - 0.12), pa, pb, { r: 0.002 });
      P(mat.doorPanel, hA + 0.04, hA + 0.044, y0, Math.min(y1, o.top - 0.12), pa, pb, { r: 0.002 });
    }
    const ph = pIn + (pOut - pIn) * 0.9;
    for (const [a0, a1] of [[hA - 0.05, hA - 0.004], [hA + 0.044, hA + 0.09]]) P(mat.steel, a0, a1, 0.98, 1.0, ph - 0.065, ph + 0.065, { r: 0.008 });
  } else if (o.type === "sliding") {
    const n = o.panels ?? 2;
    const pw = n === 1 ? wd * 0.55 : wd / n + 0.03;
    P(mat.frame, a, b, o.top - 0.04, o.top, -0.06, 0.06);
    if (o.bottom === 0) P(mat.frame, a, b, 0, 0.012, -0.06, 0.06);
    for (let i = 0; i < n; i++) {
      const a0 = n === 1 ? a + wd * 0.45 : a + i * (wd / n) - (i ? 0.015 : 0);
      const a1 = Math.min(a0 + pw, b), q = i % 2 ? 0.03 : -0.03;
      P(mat.glass, a0, a1, o.bottom + 0.05, o.top - 0.05, q - 0.004, q + 0.004, { shadow: false });
      P(mat.frame, a0, a0 + 0.045, o.bottom, o.top, q - 0.02, q + 0.02);
      P(mat.frame, a1 - 0.045, a1, o.bottom, o.top, q - 0.02, q + 0.02);
      P(mat.frame, a0, a1, o.bottom, o.bottom + 0.07, q - 0.02, q + 0.02);
      P(mat.frame, a0, a1, o.top - 0.06, o.top, q - 0.02, q + 0.02);
    }
  } else if (o.type === "window") {
    P(mat.glass, a, b, o.bottom + 0.04, o.top - 0.04, -0.004, 0.004, { shadow: false });
    P(mat.frame, a, b, o.bottom, o.bottom + 0.05, -0.03, 0.03);
    P(mat.frame, a, b, o.top - 0.05, o.top, -0.03, 0.03);
    P(mat.frame, a, a + 0.05, o.bottom, o.top, -0.03, 0.03);
    P(mat.frame, b - 0.05, b, o.bottom, o.top, -0.03, 0.03);
    if (wd > 0.7) P(mat.frame, (a + b) / 2 - 0.025, (a + b) / 2 + 0.025, o.bottom, o.top, -0.03, 0.03);
    // 窗台石
    P(mat.sill, a - 0.03, b + 0.03, o.bottom - 0.025, o.bottom, 0, inside * (t / 2 + 0.04), { r: 0.004 });
    if (o.rail) {
      const p = inside * (t / 2 + 0.07);
      P(mat.steel, a + 0.02, b - 0.02, o.bottom + 0.5, o.bottom + 0.525, p - 0.012, p + 0.012, { r: 0.01 });
      for (let u = a + 0.08; u < b - 0.05; u += 0.1) P(mat.steel, u, u + 0.016, o.bottom, o.bottom + 0.5, p - 0.008, p + 0.008);
      for (const u of [a + 0.02, b - 0.05]) P(mat.steel, u, u + 0.03, o.bottom + 0.49, o.bottom + 0.535, p, inside * (t / 2 + 0.001));
    }
  }
}
