// 柜体的抽屉缝、门板和拉手都朝正面。书架和开放衣架按宽度摆放书籍和衣物。
import { fourLegs, parts } from "./parts";
import type { FurnitureDef } from "./types";

const flat = { shadow: false };

export const storage: FurnitureDef[] = [
  { type: "nightstand", build(c) {
    const { block } = parts(c);
    fourLegs(c, 0.2, 0.03);
    block(c.style.wood, 0, 1, 0.2, 1, 0, 0.965, 0.01);
    block(c.style.woodDark, 0.07, 0.93, 0.6, 0.608, 0.964, 0.974, 0, flat);
    block(c.style.woodDark, 0.38, 0.62, 0.78, 0.81, 0.965, 1, 0.004);
  } },
  { type: "tv_stand", build(c) {
    const { block, disc } = parts(c);
    block(c.style.wood, 0, 1, 0.255, 1, 0, 0.988, 0.008);
    for (let i = 0; i < 3; i++) {
      block(c.mat.lacquer, i / 3 + 0.012, (i + 1) / 3 - 0.012, 0.298, 0.957, 0.988, 1, 0.002, flat);
    }
    for (const u of [0.04, 0.962]) for (const v of [0.15, 0.85]) {
      disc(c.style.woodDark, u, v, 0.036 / c.w, 0, 0.255, 0.028 / c.w);
    }
  } },
  { type: "cabinet", build(c) {
    const { block } = parts(c);
    const wide = c.w > 1;
    const bottom = wide ? 0.125 : 0.032;
    const top = wide ? 1 : 0.973;
    const rows = Math.max(1, Math.round((top - bottom) * c.h / 0.27));
    const { wood, woodDark } = c.style;
    if (wide) fourLegs(c, bottom, 0.03, 0.04);
    else block(woodDark, 0.04, 0.96, 0, bottom, 0.04, 0.92);
    block(wide ? wood : c.mat.lacquer, 0, 1, bottom, top, 0, 0.968, 0.01);
    if (!wide) block(wood, 0, 1, top, 1, 0, 0.988);
    for (let i = 0; i < rows; i++) {
      const y = bottom + (top - bottom) * i / rows;
      const mid = y + (top - bottom) / rows * 0.52;
      if (i) block(wide ? woodDark : c.mat.grey, 0.013, 0.987, y, y + 0.005, 0.967, 0.976, 0, flat);
      const half = Math.min(0.05 / c.w, 0.12);
      for (const x of wide ? [0.25, 0.75] : [0.5]) block(woodDark, x - half, x + half, mid, mid + 0.017, 0.968, 1, 0.004);
    }
    if (wide) block(woodDark, 0.498, 0.502, bottom + 0.012, 0.988, 0.967, 0.976, 0, flat);
  } },
  { type: "shoe_cabinet", build(c) {
    const { block } = parts(c);
    const { wood, woodDark } = c.style;
    block(c.mat.lacquer, 0.018, 0.982, 0.09, 0.973, 0.01, 0.945);
    block(wood, 0, 1, 0.973, 1, 0, 1);
    for (const y of [0.108, 0.54]) {
      block(c.mat.grey, 0.027, 0.973, y, y + 0.004, 0.944, 0.954, 0, flat);
      block(woodDark, 0.45, 0.55, y + 0.355, y + 0.368, 0.945, 0.99, 0.004);
    }
    block(c.mat.grey, 0.498, 0.502, 0.108, 0.955, 0.944, 0.954, 0, flat);
    for (const u of [0.048, 0.912]) block(woodDark, u, u + 0.04, 0, 0.09, 0.07, 0.86);
  } },
  { type: "wardrobe", build(c) {
    const { block } = parts(c);
    const { wood, woodDark } = c.style;
    block(woodDark, 0.026, 0.974, 0, 0.055, 0.025, 0.90);
    block(wood, 0, 1, 0.055, 1, 0, 0.94, 0.008);
    const count = Math.max(1, Math.round(c.w / 0.5));
    const gap = Math.min(0.003 / c.w, 0.08 / count);
    for (let i = 0; i < count; i++) {
      const start = i / count, end = (i + 1) / count;
      const handle = (i % 2 ? start + 0.13 / count : end - 0.13 / count);
      const half = Math.min(0.007 / c.w, 0.04 / count);
      block(wood, start + gap, end - gap, 0.057, 0.982, 0.94, 0.98);
      block(woodDark, handle - half, handle + half, 0.47, 0.56, 0.98, 1, 0.004);
    }
  } },
  { type: "shelf", build(c) {
    const { block } = parts(c);
    const t = Math.min(0.03 / c.w, 0.1);
    for (const x of [0, 1 - t]) block(c.style.wood, x, x + t, 0, 1, 0, 1);
    for (const y of [0.042, 0.358, 0.675, 0.975]) block(c.style.wood, 0, 1, y, y + 0.025, 0, 1);
    for (const [y, density, offset] of [[0.383, 11.25, 0], [0.7, 7.5, 3]]) {
      const count = Math.max(1, Math.round(c.w * density));
      for (let i = 0; i < count; i++) {
        const u = t + (i + 0.4) * 0.5 / count;
        block(c.clothCols[(i + offset) % c.clothCols.length], u, u + 0.43 / count,
          y, y + 0.16 + c.rand() * 0.067, 0.14, 0.8, 0.004);
      }
    }
  } },
  { type: "clothes_rack", build(c) {
    const { block } = parts(c);
    const { wood, woodDark } = c.style;
    const long = c.variant === "long";
    const a = Math.min(0.03 / c.w, 0.14), b = Math.min(0.03 / c.d, 0.19);
    for (const x of [0.01, 0.99 - a]) for (const z of [0, 1 - b]) block(woodDark, x, x + a, 0, 1, z, z + b);
    for (const y of long ? [0.038, 0.976] : [0.038, 0.452, 0.976]) block(wood, 0.01, 0.99, y, y + 0.012, 0, 1);
    block(c.mat.steel, 0.03, 0.97, 0.895, 0.905, 0.48, 0.52, 0.009);
    const count = Math.max(1, Math.round(c.w * 14));
    for (let i = 0; i < count; i++) {
      const u = 0.08 + i * 0.84 / count;
      const drop = long ? 0.405 + c.rand() * 0.19 : 0.286 + c.rand() * 0.086;
      const cloth = c.clothCols[Math.floor(c.rand() * c.clothCols.length)];
      block(wood, u, u + 0.18 / count, 0.874, 0.881, 0.14, 0.86, 0.004);
      block(cloth, u, u + 0.34 / count, 0.881 - drop, 0.876, 0.085, 0.915, 0.008);
    }
    const stacks = Math.max(1, Math.round(c.w * (long ? 4 : 3)));
    for (const [y, layers] of long ? [[0.05, 1]] : [[0.05, 2], [0.464, 3]]) {
      for (let i = 0; i < stacks; i++) for (let j = 0; j < layers; j++) {
        const u = 0.055 + i * 0.89 / stacks;
        const height = long ? 0.045 : 0.022;
        block(c.clothCols[(i * 3 + j + 1) % c.clothCols.length], u, u + 0.8 / stacks,
          y + j * height, y + (j + 1) * height, 0.11, 0.83, 0.012);
      }
    }
  } },
];
