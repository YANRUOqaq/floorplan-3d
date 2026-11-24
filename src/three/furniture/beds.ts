// 双人床与单人床共用木床架和布艺床品。折叠床保留收起的脚轮与展开的钢架。
import { sphere } from "../prims";
import { fourLegs, parts } from "./parts";
import type { FurnitureCtx, FurnitureDef } from "./types";

function bed(c: FurnitureCtx, pillows: number) {
  const { block } = parts(c);
  const { wood, woodDark, fabric, accent } = c.style;
  fourLegs(c, 0.11, 0.06, 0.02);
  block(wood, 0.02, 0.98, 0.1, 0.31, 0.035, 1, 0.008);
  block(woodDark, 0, 1, 0.1, 1, 0, 0.05, 0.015);
  block(wood, 0.045, 0.955, 0.56, 0.94, 0.045, 0.065);
  block(fabric, 0.055, 0.945, 0.286, 0.53, 0.06, 0.966, 0.05);
  block(fabric, 0.024, 0.976, 0.48, 0.61, 0.31, 0.985, 0.06);
  block(fabric, 0.03, 0.97, 0.53, 0.65, 0.275, 0.4, 0.06);
  for (let i = 0; i < pillows; i++) {
    const left = 0.12 + i * 0.76 / pillows;
    block(fabric, left, left + 0.72 / pillows, 0.54, 0.72, 0.083, 0.247, 0.045).rotation.x = -0.35;
  }
  block(accent, 0.012, 0.988, 0.61, 0.633, 0.735, 0.938, 0.01);
  for (const x of [0, 0.988]) block(accent, x, x + 0.012, 0.33, 0.633, 0.735, 0.938, 0.008);
}

export const beds: FurnitureDef[] = [
  { type: "bed", build: c => bed(c, 2) },
  { type: "single_bed", build: c => bed(c, 1) },
  { type: "folding_bed", build(c) {
    const { block, x, z } = parts(c);
    const { steel, black } = c.mat;
    const { fabric } = c.style;
    if (c.variant === "open") {
      block(steel, 0, 1, 0.52, 0.6, 0, 1, 0.01);
      for (const u of [0.022, 0.945]) for (const v of [0.016, 0.5, 0.974]) {
        block(steel, u, u + 0.033, 0, 0.52, v, v + 0.016);
      }
      block(fabric, 0.022, 0.978, 0.6, 0.84, 0.01, 0.99, 0.04);
      block(fabric, 0, 1, 0.76, 0.91, 0.29, 1, 0.05);
      block(fabric, 0.133, 0.867, 0.8, 1, 0.037, 0.227, 0.06);
    } else {
      block(steel, 0, 1, 0.04, 1, 0, 0.1, 0.008);
      block(fabric, 0.035, 0.965, 0.063, 0.98, 0.1, 1, 0.04);
      const r = Math.min(0.035, c.w * 0.06, c.d * 0.19, c.h * 0.07);
      for (const u of [0.08, 0.92]) sphere(black, x(u), r, z(0.63), r, c.g);
    }
  } },
];
