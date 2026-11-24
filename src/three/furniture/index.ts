/**
 * 家具注册表：type → 建模函数。还没有专门建模的类型先画成占位盒子。
 */
import type { FurnitureDef } from "./types";
import { R } from "../prims";

export const FURNITURE: Record<string, FurnitureDef> = {};

/** 占位：按尺寸画一个圆角盒子 */
export const placeholder: FurnitureDef = {
  type: "placeholder",
  build({ g, w, d, h, style }) {
    R(style.wood, -w / 2, w / 2, 0, h, -d / 2, d / 2, g, Math.min(0.02, h / 3));
  },
};

export const furnitureDef = (type: string): FurnitureDef => FURNITURE[type] ?? placeholder;
