/**
 * 家具注册表按类型查找本地建模函数，未知类型使用占位盒子。
 */
import type { FurnitureDef } from "./types";
import { R } from "../prims";
import { beds } from "./beds";
import { seating } from "./seating";
import { tables } from "./tables";
import { storage } from "./storage";
import { lighting } from "./lighting";
import { soft } from "./soft";
import { appliances } from "./appliances";
import { kitchenBath } from "./kitchen-bath";

export const FURNITURE: Record<string, FurnitureDef> = Object.fromEntries(
  [...beds, ...seating, ...tables, ...storage, ...lighting, ...soft, ...appliances, ...kitchenBath]
    .map(def => [def.type, def]),
);

/** 占位：按尺寸画一个圆角盒子 */
export const placeholder: FurnitureDef = {
  type: "placeholder",
  build({ g, w, d, h, style }) {
    R(style.wood, -w / 2, w / 2, 0, h, -d / 2, d / 2, g, Math.min(0.02, h / 3));
  },
};

export const furnitureDef = (type: string): FurnitureDef =>
  Object.hasOwn(FURNITURE, type) ? FURNITURE[type] : placeholder;
