// 将家具的相对坐标换成本地米制坐标。圆形部件沿宽、深独立缩放。
import type { Material } from "three";
import { R, cyl, type BoxOpts } from "../prims";
import type { FurnitureCtx } from "./types";

export function parts({ g, w, d, h }: FurnitureCtx) {
  const x = (u: number) => (u - 0.5) * w;
  const z = (v: number) => (v - 0.5) * d;
  const block = (m: Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
    radius = 0.006, opts?: BoxOpts) =>
    R(m, x(x0), x(x1), y0 * h, y1 * h, z(z0), z(z1), g, radius, 2, opts);
  const disc = (m: Material, u: number, v: number, diameter: number, y0: number, y1: number,
    top = diameter, open = false) => {
    const mesh = cyl(m, x(u), z(v), w * diameter / 2, h * y0, h * y1, g, w * top / 2, 48, open);
    mesh.scale.z = d / w;
    return mesh;
  };
  return { block, disc, x, z };
}

// 四角腿的截面以米计，留边按占地比例计算。
export function fourLegs(c: FurnitureCtx, top: number, thickness: number, inset = 0.05) {
  const { block } = parts(c);
  const a = Math.min(thickness / c.w, 0.16), b = Math.min(thickness / c.d, 0.16);
  for (const x of [inset, 1 - inset - a]) for (const z of [inset, 1 - inset - b]) {
    block(c.style.woodDark, x, x + a, 0, top, z, z + b);
  }
}
