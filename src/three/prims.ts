/**
 * 建模用的基本件：圆角盒子、圆柱、窗帘、绿植、点光源。家具和墙都由它们拼出来。
 * 从原 01 房页面移植，接口基本不变：box(材质, x0, x1, y0, y1, z0, z1, 父节点, 选项)。
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { rng } from "./textures";

export const noRay = () => {};

/**
 * 按坐标（米）写 UV：纹理比例全屋一致。木纹（纹理竖向）顺着每个面较长的方向走；
 * fixed=true 时墙面固定竖向。off 是额外加到坐标上的偏移，墙用它让瓷砖缝和世界坐标对齐。
 */
function worldUV(geo: THREE.BufferGeometry, cx: number, cy: number, cz: number, w: number, h: number, d: number, fixed: boolean) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + cx, y = p.getY(i) + cy, z = p.getZ(i) + cz;
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { if (fixed || d >= w) { u = x; v = z; } else { u = z; v = x; } }
    else if (ax >= az) { if (fixed || h >= d) { u = z; v = y; } else { u = y; v = z; } }
    else { if (fixed || h >= w) { u = x; v = y; } else { u = y; v = x; } }
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
}
const hasTex = (m: THREE.Material | THREE.Material[]) =>
  (Array.isArray(m) ? m : [m]).some(x => (x as THREE.MeshStandardMaterial).map || (x as THREE.MeshStandardMaterial).bumpMap);

export interface BoxOpts { r?: number; seg?: number; shadow?: boolean; noBlob?: boolean; fixed?: boolean; uvOff?: number }
type Mat = THREE.Material | THREE.Material[];

export function box(m: Mat, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, parent: THREE.Object3D, o: BoxOpts = {}) {
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0), d = Math.abs(z1 - z0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const r = Math.min(o.r || 0, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const geo = r > 0.0015 ? new RoundedBoxGeometry(w, h, d, o.seg || 2, r) : new THREE.BoxGeometry(w, h, d);
  if (hasTex(m)) worldUV(geo, cx + (o.uvOff || 0), cy, cz, w, h, d, !!o.fixed);
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(cx, cy, cz);
  mesh.castShadow = o.shadow !== false; mesh.receiveShadow = true;
  if (o.noBlob) mesh.userData.noBlob = true;
  parent.add(mesh); return mesh;
}
/** 圆角件：r 默认 6 mm */
export const R = (m: Mat, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, g: THREE.Object3D, r = 0.006, seg = 2, o: BoxOpts = {}) =>
  box(m, x0, x1, y0, y1, z0, z1, g, Object.assign({ r, seg }, o));

/** 竖直圆柱（或圆台）：底面圆心 (x, y0, z)，rTop 不填就是圆柱 */
export function cyl(m: THREE.Material, x: number, z: number, r: number, y0: number, y1: number, parent: THREE.Object3D, rTop?: number | null, seg = 32, open = false) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop == null ? r : rTop, r, y1 - y0, seg, 1, open), m);
  mesh.position.set(x, (y0 + y1) / 2, z); mesh.castShadow = true; mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}

export function sphere(m: THREE.Material, x: number, y: number, z: number, r: number, parent: THREE.Object3D, seg = 16) {
  const s = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg * 0.75)), m);
  s.position.set(x, y, z); s.castShadow = true; parent.add(s); return s;
}

/** 水平圆环，比如灯罩边、碗沿 */
export function ring(m: THREE.Material, x: number, y: number, z: number, r: number, tube: number, parent: THREE.Object3D) {
  const t = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 10, 48), m);
  t.rotation.x = Math.PI / 2; t.position.set(x, y, z); parent.add(t); return t;
}

/** 地面上的多边形（米）。UV = (x, -z)，和原页面的 floorRect 一致 */
export function floorPoly(m: THREE.Material, poly: [number, number][], y: number, parent: THREE.Object3D) {
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2); g.translate(0, y, 0);
  const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; mesh.userData.floor = true; parent.add(mesh); return mesh;
}
export const floorRect = (m: THREE.Material, x0: number, x1: number, z0: number, z1: number, y: number, parent: THREE.Object3D) =>
  floorPoly(m, [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], y, parent);

/**
 * 窗帘：沿本地 x 方向从 a0 到 a1，挂在 z = c 处，两种频率叠加的褶皱。
 * 家具坐标系里窗帘总是沿 x 方向，转到别的朝向靠家具整体的 rot。
 */
export function curtain(m: THREE.Material, a0: number, a1: number, c: number, y0: number, y1: number, parent: THREE.Object3D, fold = 0.11, amp = 0.045) {
  const len = a1 - a0, seg = Math.max(12, Math.round(len / 0.02));
  const g = new THREE.PlaneGeometry(len, y1 - y0, seg, 8);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), t = (y - (y0 - y1) / 2) / (y1 - y0);
    p.setZ(i, Math.sin(x / fold * Math.PI) * amp * (0.8 + 0.2 * t) + Math.sin(x / (fold * 2.7) * Math.PI + 1) * amp * 0.35);
  }
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set((a0 + a1) / 2, (y0 + y1) / 2, c);
  mesh.castShadow = !(m as THREE.MeshStandardMaterial).transparent; mesh.userData.noBlob = true; parent.add(mesh); return mesh;
}

const leafGeo = new THREE.SphereGeometry(1, 12, 8);
/** 盆栽：s 是缩放（1 = 约 1.45 m 高），叶子用 seed 决定，同一盆每次长得一样 */
export function plant(mats: { pot: THREE.Material; soil: THREE.Material; trunk: THREE.Material; leaf: THREE.Material; leaf2: THREE.Material },
  x: number, z: number, s: number, g: THREE.Object3D, seed: number) {
  const r = rng(seed);
  cyl(mats.pot, x, z, 0.14 * s, 0, 0.34 * s, g, 0.18 * s, 48);
  ring(mats.pot, x, 0.34 * s, z, 0.18 * s, 0.012 * s, g);
  cyl(mats.soil, x, z, 0.175 * s, 0.31 * s, 0.325 * s, g);
  cyl(mats.trunk, x, z, 0.02 * s, 0.32 * s, 1.35 * s, g, 0.012 * s, 10);
  for (let k = 0; k < 30; k++) {
    const hgt = (0.55 + r() * 0.95) * s, ang = k * 2.39996 + r() * 0.3, len = (0.11 + r() * 0.05) * s;
    const dir = [Math.cos(ang), Math.sin(ang)], out = (0.03 + r() * 0.06) * s;
    const leaf = new THREE.Mesh(leafGeo, k % 3 ? mats.leaf : mats.leaf2);
    leaf.scale.set(0.065 * s, 0.006 * s + 0.002, len);
    leaf.rotation.set(-(0.15 + r() * 0.55), Math.PI / 2 - ang, (r() - 0.5) * 0.5, "YXZ");
    leaf.position.set(x + dir[0] * (out + len * 0.85), hgt, z + dir[1] * (out + len * 0.85));
    leaf.castShadow = true; leaf.userData.noBlob = true; g.add(leaf);
  }
}

/**
 * 点光源。intensity 沿用原页面的数值：r155 以后灯光按物理单位计算，原来的数值要乘 π，
 * 衰减方式也变了，所以再按画面效果乘一个系数（见 LIGHT_SCALE）。
 */
export const LIGHT_SCALE = Math.PI;
export function pointLight(color: number, intensity: number, dist: number, x: number, y: number, z: number, parent: THREE.Object3D) {
  const l = new THREE.PointLight(color, intensity * LIGHT_SCALE, dist, 2); l.position.set(x, y, z); parent.add(l); return l;
}
