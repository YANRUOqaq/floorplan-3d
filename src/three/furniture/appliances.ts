// 电器保留原页的黑色屏幕、金属门缝和玻璃面板。电视与显示器的底座沿进深铺开。
import { CircleGeometry, Mesh } from "three";
import { cyl, pointLight, ring } from "../prims";
import { parts } from "./parts";
import type { FurnitureCtx, FurnitureDef } from "./types";

const flat = { shadow: false };

function display(c: FurnitureCtx, monitor: boolean) {
  const { block } = parts(c);
  const { black, screen, rgb } = c.mat;
  const bottom = monitor ? 0.373 : 0.176;
  const back = monitor ? 0.65 : 0.45;
  const front = monitor ? 0.81 : 0.637;
  block(black, 0, 1, bottom, 1, back, front, 0.008);
  block(screen, 0.015, 0.985, bottom + 0.02, 0.98, front, front + 0.012, 0, flat);
  const halfBase = monitor ? 0.141 : 0.082;
  block(black, 0.5 - halfBase, 0.5 + halfBase, 0, monitor ? 0.02 : 0.024, 0, 1, 0.01);
  const halfStand = monitor ? 0.031 : 0.025;
  block(black, 0.5 - halfStand, 0.5 + halfStand, 0.018, bottom + 0.05, back - 0.15, monitor ? back + 0.01 : front - 0.05, 0.005);
  if (monitor) {
    block(rgb, 0.045, 0.955, 0.965, 0.974, back - 0.023, back, 0, flat);
    pointLight(0x9fb4ff, 0.12, 1.6, 0, c.h * 0.76, -c.d * 0.05, c.g);
  }
}

export const appliances: FurnitureDef[] = [
  { type: "tv", build: c => display(c, false) },
  { type: "monitor", build: c => display(c, true) },
  { type: "pc_tower", build(c) {
    const { block } = parts(c);
    block(c.mat.black, 0, 1, 0, 1, 0, 0.995, 0.01);
    const glass = block(c.mat.glass, 0.125, 0.875, 0.087, 0.913, 0.995, 1, 0, flat);
    glass.renderOrder = 1;
    block(c.mat.rgb, 0.15, 0.17, 0.13, 0.87, 0.997, 1, 0, flat);
  } },
  // 上冷藏下冷冻的双门冰箱：箱体、两扇单独的门（缝 4 mm）、贴着左边的竖条拉手（两个立柱架起一根杆）
  { type: "fridge", build(c) {
    const { block } = parts(c);
    const { appliance, steel, grey } = c.mat;
    block(grey, 0.03, 0.97, 0, 0.02, 0.05, 0.9);
    block(appliance, 0, 1, 0.02, 1, 0, 0.92, 0.02);
    const split = 0.36, g = 0.002 / c.h;
    for (const [y0, y1, h0, h1] of [[0.022, split - g, 0.2, 0.32], [split + g, 1, 0.4, 0.75]]) {
      block(appliance, 0, 1, y0, y1, 0.92, 0.965, 0.015);
      const hx = 0.06 + 0.012 / c.w;
      for (const y of [h0, h1]) block(steel, hx - 0.008 / c.w, hx + 0.008 / c.w, y - 0.006 / c.h, y + 0.006 / c.h, 0.965, 0.99, 0.003);
      block(steel, hx - 0.01 / c.w, hx + 0.01 / c.w, h0 - 0.02 / c.h, h1 + 0.02 / c.h, 0.985, 1, 0.008);
    }
  } },
  // 滚筒洗衣机：机身、顶部操作面板（洗衣液盒、旋钮、显示屏）、镀铬门圈加深色玻璃门
  { type: "washer", build(c) {
    const { block, x } = parts(c);
    block(c.mat.appliance, 0, 1, 0, 1, 0, 0.95, 0.03);
    block(c.mat.grey, 0.04, 0.96, 0.835, 0.837, 0.948, 0.955, 0, flat);
    block(c.mat.appliance, 0.05, 0.36, 0.86, 0.96, 0.948, 0.962, 0.006);
    block(c.mat.screen, 0.5, 0.68, 0.89, 0.935, 0.95, 0.958, 0.002, flat);
    // 旋钮：横放的短圆柱，正面朝前
    const knob = cyl(c.mat.steel, 0, 0, Math.min(0.025, c.w * 0.04), 0, 0.02, c.g);
    knob.rotation.x = Math.PI / 2;
    knob.position.set(x(0.82), c.h * 0.91, c.d / 2 - 0.01);
    const r = Math.min(c.w * 0.283, c.h * 0.2);
    const tube = Math.min(0.025, c.d * 0.04, r * 0.15);
    const z = c.d / 2 - tube;
    const trim = ring(c.mat.grey, 0, c.h * 0.494, z, r, tube, c.g);
    trim.rotation.x = 0;
    const glass = new Mesh(new CircleGeometry(r * 0.89, 40), c.mat.screen);
    glass.position.set(0, c.h * 0.494, z + tube * 0.1);
    c.g.add(glass);
  } },
  { type: "stove", build(c) {
    const { block, x } = parts(c);
    const tube = Math.min(c.h * 0.16, c.d * 0.02, c.w * 0.02);
    block(c.mat.screen, 0, 1, 0, 1 - tube / c.h, 0, 1, 0.01);
    const radius = Math.min(0.115 * c.w, 0.178 * c.d);
    for (const u of [0.257, 0.743]) ring(c.mat.steel, x(u), c.h - tube, 0, radius, tube, c.g);
  } },
];
