// 厨房地柜带门板和踢脚，台面绕开钢水槽。卫浴洁具沿用原页的陶瓷和钢件。
import { cyl } from "../prims";
import { parts } from "./parts";
import type { FurnitureDef } from "./types";

export const kitchenBath: FurnitureDef[] = [
  // 地柜：缩进的踢脚、白色烤漆门板（3 mm 缝、上沿条形拉手）、4 cm 厚石英石台面盖过门板 1 cm；水槽是嵌在台面里的不锈钢盆，鹅颈龙头
  { type: "kitchen_counter", build(c) {
    const { block, x, z } = parts(c);
    const { granite, steel, bay, lacquer, grey } = c.mat;
    const kick = Math.min(0.1 / c.h, 0.14), top = 1 - Math.min(0.04 / c.h, 0.06), door = 0.955;
    block(grey, 0.004, 0.996, 0, kick, 0, door - Math.min(0.05 / c.d, 0.12), 0.002);
    block(lacquer, 0, 1, kick, top, 0, door, 0.003);
    const n = Math.max(1, Math.round(c.w / 0.55)), gx = 0.0015 / c.w, gy = 0.0015 / c.h;
    for (let i = 0; i < n; i++) {
      const a = i / n + gx, b = (i + 1) / n - gx, mid = (a + b) / 2, hw = Math.min(0.09 / c.w, (b - a) * 0.3);
      block(lacquer, a, b, kick + gy, top - gy, door, 0.985, 0.002);
      block(steel, mid - hw, mid + hw, top - 0.065 / c.h, top - 0.052 / c.h, 0.985, 1, 0.003);
    }
    if (c.variant === "none") { block(granite, 0, 1, top, 1, 0, 1, 0.003); return; }
    const u = c.variant === "sink-right" ? 0.808 : 0.192;
    const left = u - 0.104, right = u + 0.104;
    block(granite, 0, left, top, 1, 0, 1, 0.003);
    block(granite, right, 1, top, 1, 0, 1, 0.003);
    block(granite, left, right, top, 1, 0, 0.167, 0.003);
    block(granite, left, right, top, 1, 0.833, 1, 0.003);
    block(steel, left, right, 0.83, 0.852, 0.167, 0.833, 0.012);
    for (const edge of [left, right - 0.012]) block(steel, edge, edge + 0.012, 0.84, top + 0.004, 0.167, 0.833, 0.008);
    for (const edge of [0.167, 0.783]) block(steel, left + 0.012, right - 0.012, 0.84, top + 0.004, edge, edge + 0.05, 0.008);
    block(bay, left + 0.017, right - 0.017, 0.852, 0.857, 0.22, 0.78, 0, { shadow: false });
    // 鹅颈龙头：立管从台面升起，顶上弯向水槽，出水口朝下
    const r = Math.min(0.012, c.w * 0.025, c.d * 0.085, c.h * 0.04), riseTop = 1 - 0.02 / c.h;
    cyl(steel, x(u), z(0.12), r * 1.6, c.h * top, c.h * (top + 0.02), c.g);
    cyl(steel, x(u), z(0.12), r, c.h * top, c.h * riseTop, c.g);
    block(steel, u - r / c.w, u + r / c.w, riseTop - 0.02, riseTop + 0.0001, 0.12, 0.42, 0.01);
    cyl(steel, x(u), z(0.42), r * 0.9, c.h * (riseTop - 0.07), c.h * riseTop, c.g);
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
