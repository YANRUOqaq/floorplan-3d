// 厨房柜体保留开放柜洞，台面绕开钢水槽。卫浴洁具沿用原页的陶瓷和钢件。
import { cyl } from "../prims";
import { parts } from "./parts";
import type { FurnitureDef } from "./types";

export const kitchenBath: FurnitureDef[] = [
  { type: "kitchen_counter", build(c) {
    const { block, x, z } = parts(c);
    const { granite, steel, bay } = c.mat;
    const { wood } = c.style;
    block(granite, 0, 1, 0, 0.122, 0, 1, 0.004);
    block(bay, 0.02, 0.98, 0.122, 0.951, 0, 0.25, 0, { shadow: false });
    const partitions = c.variant === "sink-right" ? [0, 0.34, 0.66, 0.98] : [0, 0.32, 0.64, 0.98];
    for (const u of partitions) block(granite, u, u + 0.02, 0.122, 0.951, 0, 1);
    if (c.variant === "none") {
      block(wood, 0, 1, 0.951, 1, 0, 1, 0.004);
      return;
    }
    const u = c.variant === "sink-right" ? 0.808 : 0.192;
    const left = u - 0.104, right = u + 0.104;
    block(wood, 0, left, 0.951, 1, 0, 1, 0.004);
    block(wood, right, 1, 0.951, 1, 0, 1, 0.004);
    block(wood, left, right, 0.951, 1, 0, 0.167, 0.004);
    block(wood, left, right, 0.951, 1, 0.833, 1, 0.004);
    block(steel, left, right, 0.83, 0.852, 0.167, 0.833, 0.012);
    for (const edge of [left, right - 0.012]) block(steel, edge, edge + 0.012, 0.84, 1, 0.167, 0.833, 0.008);
    for (const edge of [0.167, 0.783]) block(steel, left + 0.012, right - 0.012, 0.84, 1, edge, edge + 0.05, 0.008);
    block(bay, left + 0.017, right - 0.017, 0.852, 0.857, 0.22, 0.78, 0, { shadow: false });
    // 台面标高固定为 h，龙头在靠墙的槽沿内抬起。
    const r = Math.min(0.014, c.w * 0.025, c.d * 0.085, c.h * 0.04);
    cyl(steel, x(u), z(0.12), r, c.h * 0.958, c.h * 0.993, c.g);
    block(steel, u - r / c.w, u + r / c.w, 0.977, 1, 0.105, 0.405, 0.01);
  } },
  { type: "toilet", build(c) {
    const { block, disc } = parts(c);
    const { ceramic } = c.mat;
    block(ceramic, 0.024, 0.976, 0.5, 1, 0, 0.313, 0.03);
    disc(ceramic, 0.5, 0.6, 0.8, 0, 0.475, 0.688);
    block(ceramic, 0, 1, 0.475, 0.525, 0.313, 1, 0.02);
  } },
  { type: "basin", build(c) {
    const { block, disc } = parts(c);
    const { ceramic } = c.mat;
    disc(ceramic, 0.5, 0.38, 0.31, 0, 0.884, 0.4);
    block(ceramic, 0, 1, 0.884, 1, 0, 1, 0.035);
  } },
  { type: "shower", build(c) {
    const { block, x, z } = parts(c);
    const { steel } = c.mat;
    const r = Math.min(0.012, c.w / 7, c.d / 7);
    cyl(steel, x(0.49), z(0.25), r * 0.55, 0, c.h * 0.461, c.g);
    cyl(steel, x(0.49), z(0.25), r, c.h * 0.459, c.h * 0.995, c.g);
    block(steel, 0, 1, 0.98, 1, 0, 1, 0.01);
  } },
];
