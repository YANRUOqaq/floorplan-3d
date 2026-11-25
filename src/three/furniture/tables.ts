import { ExtrudeGeometry, Mesh, Shape } from "three";
import { cyl } from "../prims";
import { parts } from "./parts";
import type { FurnitureCtx, FurnitureDef } from "./types";

function roundTop(c: FurnitureCtx, underside: number) {
  const bevel = 0.005;
  const outline = new Shape();
  outline.absellipse(0, 0, c.w / 2 - bevel, c.d / 2 - bevel, 0, Math.PI * 2, false, 0);
  const geo = new ExtrudeGeometry(outline, {
    depth: (1 - underside) * c.h - 2 * bevel,
    curveSegments: 24,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
  });
  const top = new Mesh(geo, c.style.wood);
  top.rotation.x = -Math.PI / 2;
  top.position.y = underside * c.h + bevel;
  top.castShadow = top.receiveShadow = true;
  c.g.add(top);
}

function legFrame(c: FurnitureCtx, top: number, radius: number, apronHeight: number, frontHeight = apronHeight) {
  const { block, x, z } = parts(c);
  const u = (radius + 0.02) / c.w, v = (radius + 0.02) / c.d;
  const a = radius * 0.4 / c.w, b = radius * 0.4 / c.d;
  const { wood, woodDark } = c.style;
  for (const px of [u, 1 - u]) for (const pz of [v, 1 - v]) {
    cyl(woodDark, x(px), z(pz), radius * 0.68, 0, top * c.h + 0.001, c.g, radius, 24);
  }
  block(wood, u, 1 - u, top - apronHeight / c.h, top + 0.001 / c.h, v - b, v + b, 0.003);
  block(wood, u, 1 - u, top - frontHeight / c.h, top + 0.001 / c.h, 1 - v - b, 1 - v + b, 0.003);
  for (const px of [u, 1 - u]) {
    block(wood, px - a, px + a, top - apronHeight / c.h, top + 0.001 / c.h, v, 1 - v, 0.003);
  }
}

export const tables: FurnitureDef[] = [
  // 双层茶几用倒角桌面，矩形款用四脚，圆款用贯通下层托盘的中柱。
  { type: "coffee_table", build(c) {
    const { block, disc } = parts(c);
    const { wood, woodDark } = c.style;
    const top = 1 - Math.min(0.046, c.h * 0.10) / c.h;
    if (c.variant === "round") {
      roundTop(c, top);
      disc(wood, 0.5, 0.5, 0.72, 0.32, 0.32 + Math.min(0.024 / c.h, 0.07), 0.74);
      disc(woodDark, 0.5, 0.5, 0.19, 0.065, top + 0.001 / c.h, 0.14);
      disc(woodDark, 0.5, 0.5, 0.66, 0, 0.069, 0.59);
    } else {
      block(wood, 0, 1, top, 1, 0, 1, 0.005);
      legFrame(c, top, 0.018, 0.032);
      block(wood, 0.038 / c.w, 1 - 0.038 / c.w, 0.3,
        0.3 + Math.min(0.022 / c.h, 0.065), 0.038 / c.d, 1 - 0.038 / c.d, 0.004);
    }
  } },
  // 矩形餐桌
  { type: "dining_table", build(c) {
    const { block, disc } = parts(c);
    const { wood, woodDark } = c.style;
    const top = 1 - 0.036 / c.h;
    if (c.variant === "round") {
      roundTop(c, top);
      disc(woodDark, 0.5, 0.5, 0.16, 0.046, top + 0.001 / c.h, 0.108);
      disc(woodDark, 0.5, 0.5, 0.64, 0, 0.052, 0.58);
    } else {
      block(wood, 0, 1, top, 1, 0, 1, 0.005);
      legFrame(c, top, Math.min(0.034, Math.min(c.w, c.d) * 0.045), 0.058);
    }
  } },
  // 书桌用薄倒角桌面和收分圆腿，前侧桌裙较浅，给膝盖留出高度。
  { type: "desk", build(c) {
    const { block } = parts(c);
    const top = 1 - 0.028 / c.h;
    block(c.style.wood, 0, 1, top, 1, 0, 1, 0.005);
    legFrame(c, top, 0.025, 0.047, 0.032);
  } },
];
