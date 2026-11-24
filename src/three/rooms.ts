/**
 * 房间：地面、天花板、墙根和顶角暗角、吸顶灯、地基。
 * 原页面按矩形 REG 画，这里改成按任意多边形画（ShapeGeometry）。
 */
import * as THREE from "three";
import type { House, Vec2 } from "../model/schema";
import { labelPoint, pointInPolygon } from "../model/geometry";
import type { Materials } from "./materials";
import { roomFloorMat } from "./materials";
import { cyl, floorPoly, noRay } from "./prims";

export function buildRooms(house: House, m: Materials) {
  const fixed = new THREE.Group(), ceil = new THREE.Group();
  const floors: THREE.Mesh[] = [];
  const lamps: { x: number; z: number; mesh: THREE.Mesh }[] = [];
  const H = house.height;
  for (const r of house.rooms) {
    const fm = roomFloorMat(m, house, r);
    floors.push(floorPoly(fm, r.polygon, r.floor === "wood" ? 0.004 : 0, fixed));
    // 地基：地面下 12 cm 厚的板，鸟瞰时有厚度
    const slab = new THREE.ExtrudeGeometry(new THREE.Shape(r.polygon.map(([x, z]) => new THREE.Vector2(x, -z))), { depth: 0.118, bevelEnabled: false });
    slab.rotateX(-Math.PI / 2); slab.translate(0, -0.12, 0);
    const sm = new THREE.Mesh(slab, m.mat.base); sm.receiveShadow = true; sm.raycast = noRay; fixed.add(sm);
    // 天花板
    const cg = new THREE.ShapeGeometry(new THREE.Shape(r.polygon.map(([x, z]) => new THREE.Vector2(x, z))));
    cg.rotateX(Math.PI / 2); cg.translate(0, H, 0);
    const c = new THREE.Mesh(cg, m.mat.ceiling); c.castShadow = true; ceil.add(c);
    if (r.outdoor) continue;
    // 墙根和顶角的暗角：每条边往房间里铺一条渐变
    for (let i = 0; i < r.polygon.length; i++) {
      const A = r.polygon[i], B = r.polygon[(i + 1) % r.polygon.length];
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L < 1e-6) continue;
      let nx = -(B[1] - A[1]) / L, nz = (B[0] - A[0]) / L;
      const mid: Vec2 = [(A[0] + B[0]) / 2 + nx * 0.02, (A[1] + B[1]) / 2 + nz * 0.02];
      if (!pointInPolygon(mid, r.polygon)) { nx = -nx; nz = -nz; }
      for (const [y, grp, dep] of [[0.011, fixed, 0.32], [H - 0.004, ceil, 0.4]] as const) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute([A[0], y, A[1], B[0], y, B[1], B[0] + nx * dep, y, B[1] + nz * dep, A[0] + nx * dep, y, A[1] + nz * dep], 3));
        geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 1, 1, 0], 2));
        geo.setIndex([0, 1, 2, 0, 2, 3]);
        const s = new THREE.Mesh(geo, m.mat.edge); s.raycast = noRay; s.renderOrder = 1; grp.add(s);
      }
    }
    // 吸顶灯放在房间中间（L 形房间放在房间里离质心最近的地方）
    const [x, z] = labelPoint(r.polygon);
    lamps.push({ x, z, mesh: cyl(m.mat.lamp, x, z, 0.17, H - 0.07, H, ceil, 0.2, 48) });
  }
  return { fixed, ceil, floors, lamps };
}
