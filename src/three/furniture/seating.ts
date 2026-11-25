// 木椅、凳和长凳沿用原页构造。布艺沙发共用扶手与坐靠垫，办公椅使用五星脚轮架。
import { Group } from "three";
import { R, sphere } from "../prims";
import { fourLegs, parts } from "./parts";
import type { FurnitureCtx, FurnitureDef } from "./types";

function upholstery(c: FurnitureCtx, seats: number, chaise: boolean) {
  const g = new Group();
  c.g.add(g);
  if (chaise && c.variant === "left") g.scale.x = -1;
  const { block, disc, soft } = parts({ ...c, g });
  const { fabric, woodDark, accent } = c.style;
  const front = chaise ? 0.57 : 1;
  block(fabric, 0, 1, 0.078, 0.444, 0, front, 0.035);
  block(fabric, 0.055, 0.945, 0.42, 0.78, 0, 0.155, 0.05);
  // 扶手顶部圆鼓
  soft(fabric, 0, 0.084, 0.078, 0.69, 0, front, 0.06, 0.08);
  if (chaise) block(fabric, 0.655, 1, 0.078, 0.444, front - 0.02, 1, 0.035);
  else soft(fabric, 0.916, 1, 0.078, 0.69, 0, front, 0.06, 0.08);

  for (const [u, v] of [[0.025, 0.065], [0.97, 0.065], [0.025, front - 0.045], [0.97, 0.955],
    ...(chaise ? [[0.68, 0.955], [0.68, front - 0.02]] : [])]) {
    disc(woodDark, u, v, 0.044 / c.w, 0, 0.08, 0.036 / c.w);
  }
  const span = (chaise ? 0.99 : 0.91) - 0.09;
  for (let i = 0; i < seats; i++) {
    const u = 0.09 + i * span / seats;
    const end = u + span / seats - 0.008;
    const longSeat = chaise && i === seats - 1;
    // 坐垫顶面微鼓，靠垫更蓬
    soft(fabric, u, end, 0.433, 0.58, 0.145, longSeat ? 0.986 : front - 0.012, 0.045, 0.22);
    soft(fabric, u, end, 0.52, 0.98, 0.13, 0.27, 0.06, 0.45).rotation.x = -0.12;
  }
  const pillow = (u: number) => soft(accent, u, u + 0.16, 0.56, 0.96, 0.25, 0.37, 0.05, 0.7);
  pillow(0.11).rotation.x = -0.22;
  if (seats > 1) pillow(0.8 - (chaise ? 0 : 0.1)).rotation.x = -0.22;
  if (chaise) {
    block(accent, 0.75, 0.977, 0.566, 0.594, 0.61, 0.989, 0.01);
    block(accent, 0.75, 0.977, 0.245, 0.594, 0.987, 1, 0.01);
  }
}

export const seating: FurnitureDef[] = [
  { type: "sofa_l", build: c => upholstery(c, 3, true) },
  { type: "sofa", build: c => upholstery(c, 3, false) },
  { type: "armchair", build: c => upholstery(c, 1, false) },
  { type: "chair", build(c) {
    const { block } = parts(c);
    const { wood, woodDark, fabric } = c.style;
    fourLegs(c, 0.478, 0.03);
    block(wood, 0, 1, 0.478, 0.511, 0, 1, 0.012);
    parts(c).soft(fabric, 0.071, 0.929, 0.511, 0.545, 0.071, 0.929, 0.012, 0.5);
    for (const u of [0.048, 0.881]) block(woodDark, u, u + 0.071, 0.478, 1, 0, 0.071);
    for (const y of [0.689, 0.8, 0.933]) block(wood, 0.048, 0.952, y, y + 0.055, 0.008, 0.067, 0.008);
  } },
  { type: "stool", build(c) {
    fourLegs(c, 0.935, 0.03, 0.075);
    parts(c).block(c.style.wood, 0, 1, 0.935, 1, 0, 1, 0.01);
  } },
  { type: "bench", build(c) {
    const { block } = parts(c);
    block(c.style.wood, 0, 1, 0.91, 1, 0, 1, 0.01);
    for (const u of [0.038, 0.912]) block(c.style.woodDark, u, u + 0.05, 0, 0.91, 0.086, 0.914);
    block(c.style.wood, 0.062, 0.938, 0.267, 0.311, 0.086, 0.914);
  } },
  { type: "office_chair", build(c) {
    const { block, disc, x, z } = parts(c);
    const { w, d, h, g } = c;
    const { black } = c.mat;
    const { fabric } = c.style;
    const wheel = Math.min(0.025, w * 0.053, d * 0.053, h * 0.04);
    disc(black, 0.5, 0.5, 0.083, 0.064, 0.336);
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5 + Math.PI / 2;
      const dx = x(0.5 + 0.445 * Math.cos(a)), dz = z(0.5 + 0.445 * Math.sin(a));
      const length = Math.hypot(dx, dz);
      const leg = R(black, -length / 2, length / 2, wheel * 2, wheel * 2 + h * 0.024, -wheel * 0.8, wheel * 0.8, g, 0.012);
      leg.rotation.y = -Math.atan2(dz, dx);
      leg.position.x = dx / 2;
      leg.position.z = dz / 2;
      sphere(black, dx, wheel, dz, wheel, g, 12);
    }
    const { soft } = parts(c);
    soft(fabric, 0.075, 0.925, 0.336, 0.415, 0.19, 0.93, 0.035, 0.3);
    soft(fabric, 0.15, 0.85, 0.43, 0.998, 0.055, 0.17, 0.03, 0.4).rotation.x = -0.07;
    block(black, 0.45, 0.55, 0.365, 0.52, 0.12, 0.21);
    for (const u of [0.07, 0.872]) {
      block(black, u, u + 0.058, 0.525, 0.55, 0.25, 0.78, 0.012);
      block(black, u + 0.008, u + 0.05, 0.384, 0.525, 0.49, 0.55);
    }
  } },
];
