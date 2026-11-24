// 电器保留原页的黑色屏幕、金属门缝和玻璃面板。电视与显示器的底座沿进深铺开。
import { CircleGeometry, Mesh } from "three";
import { pointLight, ring } from "../prims";
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
  { type: "fridge", build(c) {
    const { block } = parts(c);
    block(c.mat.appliance, 0, 1, 0, 1, 0, 0.977, 0.025);
    block(c.mat.grey, 0.013, 0.987, 0.629, 0.632, 0.976, 0.98, 0, flat);
    block(c.mat.steel, 0.093, 0.133, 0.543, 0.771, 0.977, 1, 0.006);
  } },
  { type: "washer", build(c) {
    const { block } = parts(c);
    block(c.mat.appliance, 0, 1, 0, 1, 0, 0.95, 0.03);
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
