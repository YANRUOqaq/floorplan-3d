// 木桌保留桌裙和四角腿。圆茶几有下层板与脚轮，圆餐桌有独立中柱。
import { sphere } from "../prims";
import { fourLegs, parts } from "./parts";
import type { FurnitureDef } from "./types";

export const tables: FurnitureDef[] = [
  { type: "coffee_table", build(c) {
    const { block, disc, x, z } = parts(c);
    const { wood, woodDark } = c.style;
    if (c.variant === "round") {
      disc(wood, 0.5, 0.5, 1, 0.933, 1);
      disc(wood, 0.5, 0.5, 0.8, 0.355, 0.4);
      const r = Math.min(c.w * 0.06, c.d * 0.06, c.h * 0.055);
      for (let i = 0; i < 3; i++) {
        const angle = i * Math.PI * 2 / 3 + 0.5;
        const u = 0.5 + Math.cos(angle) * 0.367, v = 0.5 + Math.sin(angle) * 0.367;
        disc(woodDark, u, v, 0.053, 2 * r / c.h, 0.933, 0.067);
        sphere(c.mat.black, x(u), r, z(v), r, c.g);
      }
    } else {
      fourLegs(c, 0.92, 0.035);
      block(wood, 0, 1, 0.92, 1, 0, 1, 0.015);
      block(wood, 0.055, 0.945, 0.3, 0.37, 0.06, 0.94);
    }
  } },
  { type: "dining_table", build(c) {
    const { block, disc } = parts(c);
    const { wood, woodDark } = c.style;
    if (c.variant === "round") {
      disc(wood, 0.5, 0.5, 1, 0.964, 1);
      disc(woodDark, 0.5, 0.5, 0.072, 0.03, 0.964);
      disc(woodDark, 0.5, 0.5, 0.57, 0, 0.03);
    } else {
      block(wood, 0, 1, 0.953, 1, 0, 1, 0.012);
      block(wood, 0.05, 0.95, 0.853, 0.953, 0.08, 0.92, 0.004);
      fourLegs(c, 0.953, 0.045, 0.034);
    }
  } },
  { type: "desk", build(c) {
    const { block } = parts(c);
    block(c.style.wood, 0, 1, 0.96, 1, 0, 1, 0.01);
    block(c.style.wood, 0.042, 0.958, 0.853, 0.96, 0.05, 0.12, 0.004);
    fourLegs(c, 0.96, 0.04, 0.032);
  } },
];
