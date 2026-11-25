import type { Material } from "three";
import { cyl } from "../prims";
import { fourLegs, parts } from "./parts";
import type { FurnitureCtx, FurnitureDef } from "./types";

function caseFront(c: FurnitureCtx, frame: Material, bottom: number) {
  const { block, x, z } = parts(c);
  const face = 1 - 0.029 / c.d;
  const back = face - 0.018 / c.d;
  const side = 0.014 / c.w, rail = 0.014 / c.h;
  const gapX = 0.00125 / c.w, gapY = 0.00125 / c.h;

  for (const u of [0, 1 - side]) block(frame, u, u + side, bottom, 1, 0, face, 0.003);
  for (const y of [bottom, 1 - rail]) block(frame, side, 1 - side, y, y + rail, 0, face, 0.003);
  block(c.style.woodDark, side, 1 - side, bottom + rail, 1 - rail, 0, back + 0.001 / c.d, 0);

  return (material: Material, columns: number, rows: number, vertical = false, pullHeight = 0.5) => {
    const width = (1 - 2 * side) / columns;
    const height = (1 - bottom - 2 * rail) / rows;
    const handleZ = z(face) + 0.025;
    for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
      const u = side + col * width;
      const y = bottom + rail + row * height;
      block(material, u + (col === 0 ? 2 : 1) * gapX, u + width - (col === columns - 1 ? 2 : 1) * gapX,
        y + (row === 0 ? 2 : 1) * gapY, y + height - (row === rows - 1 ? 2 : 1) * gapY, back, face, 0.0025);

      const cx = x(u + width * (vertical ? (col % 2 ? 0.17 : 0.83) : 0.5));
      const cy = (y + height * pullHeight) * c.h;
      const length = vertical ? Math.min(0.26, height * c.h * 0.16) : Math.min(0.22, width * c.w * 0.34);
      const half = length / 2;
      const bar = cyl(c.mat.steel, cx, handleZ, 0.004, cy - half, cy + half, c.g, 0.004, 12);
      if (!vertical) bar.rotation.z = Math.PI / 2;
      for (const end of [-1, 1]) {
        const offset = end * (half - 0.007);
        const post = cyl(c.mat.steel, cx + (vertical ? 0 : offset), (z(face) + handleZ) / 2,
          0.0035, cy + (vertical ? offset : 0) - 0.013, cy + (vertical ? offset : 0) + 0.013, c.g, 0.0035, 12);
        post.rotation.x = Math.PI / 2;
      }
    }
  };
}

function plinth(c: FurnitureCtx, top: number) {
  const { block } = parts(c);
  const x = 0.04 / c.w, z = 0.04 / c.d;
  block(c.style.woodDark, x, 1 - x, 0, top, z, 1 - (0.029 + 0.04) / c.d, 0.003);
}

export const storage: FurnitureDef[] = [
  // 四脚木质床头柜用双抽屉，圆角面板与金属拉手在近处也有层次。
  { type: "nightstand", build(c) {
    const bottom = 0.18;
    fourLegs(c, bottom + 0.003, 0.03);
    caseFront(c, c.style.wood, bottom)(c.style.wood, 1, 2);
  } },
  // 低矮电视柜以木框围住三扇漆面门，深色踢脚收进柜底。
  { type: "tv_stand", build(c) {
    const bottom = 0.12;
    plinth(c, bottom + 0.003);
    caseFront(c, c.style.wood, bottom)(c.mat.lacquer, 3, 1, false, 0.72);
  } },
  // 窄斗柜用踢脚承托漆面抽屉，宽款改用细腿和双列木抽屉。
  { type: "cabinet", build(c) {
    const wide = c.w > 1;
    const bottom = wide ? 0.125 : 0.085;
    const rows = Math.max(1, Math.round((1 - bottom) * c.h / 0.27));
    if (wide) fourLegs(c, bottom + 0.003, 0.03, 0.04);
    else plinth(c, bottom + 0.003);
    caseFront(c, c.style.wood, bottom)(wide ? c.style.wood : c.mat.lacquer, wide ? 2 : 1, rows);
  } },
  // 漆面鞋柜用上置拉手表现翻斗门，踢脚留出脚尖空间。
  { type: "shoe_cabinet", build(c) {
    const bottom = 0.09;
    plinth(c, bottom + 0.003);
    caseFront(c, c.style.wood, bottom)(c.mat.lacquer, c.w >= 0.8 ? 2 : 1,
      Math.max(2, Math.round(c.h / 0.53)), false, 0.78);
  } },
  // 通高木门按柜宽分扇，竖拉手靠近开门侧，深色踢脚压低底部视觉重心。
  { type: "wardrobe", build(c) {
    const bottom = Math.min(0.09 / c.h, 0.06);
    plinth(c, bottom + 0.003);
    caseFront(c, c.style.wood, bottom)(c.style.wood, Math.max(1, Math.round(c.w / 0.5)), 1, true);
  } },
  // 开放书架加厚层板前沿，错落排列的书旁留出空间放平叠的书。
  { type: "shelf", build(c) {
    const { block } = parts(c);
    const { wood, woodDark } = c.style;
    const side = Math.min(0.024 / c.w, 0.09);
    const lip = 1 - 0.025 / c.d;
    const thick = Math.min(0.024 / c.h, 0.06);
    for (const u of [0, 1 - side]) block(wood, u, u + side, 0, 1, 0, 1);
    const levels = [0.025, 0.345, 0.655, 1 - thick];
    for (const y of levels) {
      block(wood, side, 1 - side, y, y + thick, 0, lip, 0.0025);
      block(woodDark, side, 1 - side, y - thick * 0.2, y + thick, lip, 1, 0.003);
    }
    for (const level of [1, 2]) {
      const y = levels[level] + thick;
      const opening = levels[level + 1] - thick * 0.2 - y;
      const span = (1 - 2 * side) * 0.59;
      const count = Math.max(1, Math.round(span * c.w / 0.048));
      const slot = span / count;
      for (let i = 0; i < count; i++) {
        const u = side + 0.1 * slot + i * slot;
        const width = slot * (0.52 + c.rand() * 0.42);
        const height = Math.min(opening * (0.57 + c.rand() * 0.33), 0.34 / c.h);
        const depth = 0.38 + c.rand() * 0.27;
        block(c.clothCols[(i + level * 3) % c.clothCols.length], u, u + width,
          y, y + height, 0.14, 0.14 + depth, 0.002, { seg: 1 });
      }
      if (c.rand() < 0.65) {
        const height = Math.min(opening * 0.14, 0.025 / c.h);
        const start = side + (1 - 2 * side) * 0.68;
        const width = Math.min((1 - 2 * side) * 0.24, 0.28 / c.w);
        for (let i = 0; i < 2; i++) {
          const u = start + width * i * 0.08;
          block(c.clothCols[(level + i) % c.clothCols.length], u, start + width,
            y + height * i, y + height * (i + 1), 0.17 + i * 0.04, 0.66, 0.002);
        }
      }
    }
  } },
  // 开放衣架保留长挂与中隔板款，层板前沿加厚，挂杆两端接到立柱。
  { type: "clothes_rack", build(c) {
    const { block } = parts(c);
    const { wood, woodDark } = c.style;
    const long = c.variant === "long";
    const a = 0.03 / c.w, b = 0.03 / c.d;
    const sides = [0.01, 0.99 - a];
    for (const u of sides) for (const v of [0, 1 - b]) block(woodDark, u, u + a, 0, 1, v, v + b);
    for (const y of long ? [0.038, 0.976] : [0.038, 0.417, 0.976]) {
      block(wood, 0.01, 0.99, y, y + 0.012, 0, 1 - b, 0.003);
      block(woodDark, 0.01 + a, 0.99 - a, y - 0.008, y + 0.012, 1 - b, 1, 0.003);
    }
    const rodY = 0.9 * c.h, rodRadius = 0.008;
    for (const u of sides) {
      block(woodDark, u, u + a, (rodY - 0.015) / c.h, (rodY + 0.015) / c.h, b / 2, 1 - b / 2, 0.003);
    }
    const rod = cyl(c.mat.steel, 0, 0, rodRadius, rodY - (0.49 * c.w - 0.015),
      rodY + (0.49 * c.w - 0.015), c.g, rodRadius, 16);
    rod.rotation.z = Math.PI / 2;
    const count = Math.max(1, Math.round(c.w * 14));
    for (let i = 0; i < count; i++) {
      const u = 0.10 + i * 0.80 / count;
      const drop = long ? 0.405 + c.rand() * 0.19 : 0.286 + c.rand() * 0.086;
      const cloth = c.clothCols[Math.floor(c.rand() * c.clothCols.length)];
      const hangerWidth = 0.18 / count;
      block(c.mat.steel, u, u + hangerWidth, 0.879, 0.9, 0.5 - 0.002 / c.d, 0.5 + 0.002 / c.d, 0);
      block(wood, u, u + hangerWidth, 0.874, 0.881, 0.14, 0.86, 0.002, { seg: 1 });
      block(cloth, u, u + 0.34 / count, 0.881 - drop, 0.876, 0.085, 0.915, 0.008, { seg: 1 });
    }
    const stacks = Math.max(1, Math.round(c.w * (long ? 4 : 3)));
    for (const [y, layers] of long ? [[0.05, 1]] : [[0.05, 2], [0.429, 3]]) {
      const box = y === 0.05 && stacks >= 3 && c.rand() < 0.65;
      const folded = stacks - Number(box);
      if (box) {
        const u = 0.055 + folded * 0.89 / stacks;
        block(c.mat.grey, u, u + 0.8 / stacks, y, y + 0.048, 0.13, 0.81, 0.004);
        block(woodDark, u, u + 0.8 / stacks, y + 0.048, y + 0.055, 0.13, 0.81, 0.0025);
      }
      for (let i = 0; i < folded; i++) for (let j = 0; j < layers; j++) {
        const u = 0.055 + i * 0.89 / stacks;
        const height = long ? 0.045 : 0.022;
        block(c.clothCols[(i * 3 + j + 1) % c.clothCols.length], u, u + 0.8 / stacks,
          y + j * height, y + (j + 1) * height, 0.11, 0.83, 0.012, { seg: 1 });
      }
    }
  } },
];
