/**
 * 把一份 House 数据变成 three.js 场景里的各个部分：墙（完整高度和鸟瞰切矮两套）、
 * 房间地面天花板、家具、接触阴影、走动范围、房间标签和自动视角。
 * viewer.ts 只负责显示和交互，不关心这些东西是怎么来的。
 */
import * as THREE from "three";
import type { House, Item } from "../model/schema";
import { CATALOG_BY_TYPE } from "../model/catalog";
import { autoRoomView, houseBBox, labelPoint, makeWalkable, polygonArea, type Blocker } from "../model/geometry";
import { itemStyle, type Materials } from "./materials";
import { buildRooms } from "./rooms";
import { buildWalls, H_CUT } from "./walls";
import { furnitureDef } from "./furniture";
import { noRay } from "./prims";
import { rng } from "./textures";

export interface View { key: string; name: string; orbit?: boolean; at?: [number, number]; look?: [number, number, number]; pos?: [number, number, number]; tgt?: [number, number, number] }

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/** 按家具类型建模，摆到房间里。返回的 group 带 userData.id，点击时用来查是哪件家具 */
export function buildItem(house: House, it: Item, m: Materials): THREE.Group {
  const cat = CATALOG_BY_TYPE[it.type];
  const g = new THREE.Group();
  g.userData.id = it.id;
  const [w, d, h] = it.size;
  furnitureDef(it.type).build({
    g, w, d, h,
    variant: it.variant ?? cat?.variants?.[0] ?? "",
    ceil: house.height - (it.elevation ?? 0),
    rand: rng(hash(it.id)),
    style: itemStyle(m, house, it),
    mat: m.mat,
    clothCols: m.clothCols,
  });
  if (cat?.mount !== "ceiling") addContactShadows(g, m);
  g.position.set(it.pos[0], it.elevation ?? 0, it.pos[1]);
  g.rotation.y = it.rot * Math.PI / 180;
  return g;
}

/** 接触阴影：每个落地部件脚下一块小的柔边暗影，整件家具下面再一块淡的，让东西“落地” */
const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
function addContactShadows(g: THREE.Group, m: Materials) {
  g.updateMatrixWorld(true);
  const tmp = new THREE.Box3(), all = new THREE.Box3();
  const blobs: [number, number, number, number, number][] = [];
  g.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || o.userData.noBlob || o.userData.floor) return;
    tmp.setFromObject(o);
    if (tmp.min.y > 0.06 || tmp.max.y - tmp.min.y < 0.03) { if (tmp.max.y > 0.03) all.union(tmp); return; }
    all.union(tmp);
    const w = tmp.max.x - tmp.min.x, d = tmp.max.z - tmp.min.z, pad = Math.min(0.22, Math.max(0.06, Math.min(w, d) * 0.5));
    blobs.push([(tmp.min.x + tmp.max.x) / 2, (tmp.min.z + tmp.max.z) / 2, w + pad, d + pad, 0.5]);
  });
  if (!all.isEmpty() && all.min.y < 0.5) blobs.push([(all.min.x + all.max.x) / 2, (all.min.z + all.max.z) / 2, all.max.x - all.min.x + 0.3, all.max.z - all.min.z + 0.3, 0.2]);
  for (const [x, z, w, d, op] of blobs) {
    const sm = m.mat.shadow.clone(); sm.opacity = op;
    const b = new THREE.Mesh(blobGeo, sm); b.scale.set(w, 1, d); b.position.set(x, 0.012, z); b.raycast = noRay; b.renderOrder = 2;
    b.userData.blob = true;
    g.add(b);
  }
}

export function buildHouse(house: House, m: Materials) {
  const { fixed, ceil, floors, lamps } = buildRooms(house, m);
  const items = new THREE.Group();
  const itemGroups = new Map<string, THREE.Group>();
  const orbitHidden: THREE.Object3D[] = [];
  const blockers: Blocker[] = [];
  const tmp = new THREE.Box3();
  for (const it of house.furniture) {
    const g = buildItem(house, it, m);
    items.add(g); itemGroups.set(it.id, g);
    const mount = CATALOG_BY_TYPE[it.type]?.mount;
    // 鸟瞰时藏起来：落地窗帘和吊灯会挡住视线
    if (mount === "ceiling" || (it.type === "curtain" && (it.elevation ?? 0) + it.size[2] > H_CUT + 0.5)) orbitHidden.push(g);
    if (mount === "ceiling") for (const l of lamps) if (Math.hypot(l.x - it.pos[0], l.z - it.pos[1]) < 0.6) l.mesh.visible = false;
    // 走动时绕开的家具占地：落地、高过 12 cm 的东西
    g.updateMatrixWorld(true);
    tmp.makeEmpty();
    g.traverse(o => { if ((o as THREE.Mesh).isMesh && !o.userData.blob) tmp.expandByObject(o); });
    if (!tmp.isEmpty() && tmp.max.y > 0.12 && tmp.min.y < 0.2) blockers.push({ r: [tmp.min.x - 0.15, tmp.max.x + 0.15, tmp.min.z - 0.15, tmp.max.z + 0.15], active: () => g.visible });
  }

  const walk = makeWalkable(house);
  const walkable = (x: number, z: number) => walk(x, z, blockers);
  const labels = house.rooms.map(r => {
    const [x, z] = labelPoint(r.polygon);
    return { name: r.name, area: polygonArea(r.polygon), x, z };
  });

  const bb = houseBBox(house);
  const cx = (bb.x0 + bb.x1) / 2, cz = (bb.z0 + bb.z1) / 2;
  const span = Math.max(bb.x1 - bb.x0, bb.z1 - bb.z0, 3);
  const views: View[] = [];
  for (const r of house.rooms) {
    if (r.outdoor || polygonArea(r.polygon) < 2) continue;
    const v = autoRoomView(house, r, walkable);
    views.push({ key: r.id, name: r.name, at: v.at, look: v.look });
  }
  views.push({ key: "overview", name: "鸟瞰", orbit: true, pos: [cx - 0.1, 0.9 * span, cz + 0.88 * span], tgt: [cx, 0, cz] });
  views.push({ key: "top", name: "俯视", orbit: true, pos: [cx, 1.26 * span, cz + 0.01], tgt: [cx, 0, cz] });

  return {
    fixed, ceil, floors, lamps, items, itemGroups, orbitHidden, blockers, walkable, labels, views,
    bbox: bb, center: [cx, cz] as [number, number], span,
    walls: (cut: boolean) => buildWalls(house, m, cut),
  };
}
export type BuiltHouse = ReturnType<typeof buildHouse>;

/** 释放几何体（材质和纹理在多次重建之间复用，不释放） */
export function disposeTree(o: THREE.Object3D) {
  o.traverse(x => { const mesh = x as THREE.Mesh; if (mesh.geometry && mesh.geometry !== blobGeo) mesh.geometry.dispose(); });
}
