/**
 * 家具库的接口。每种家具一个 FurnitureDef，build() 在本地坐标里拼出外形：
 * - 原点在占地中心、地面高度（放在桌上的东西，原点在它自己的底面）；
 * - 宽度 w 沿本地 x（-w/2 ~ w/2），进深 d 沿本地 z，背面在 z = -d/2，正面朝 +z；
 * - 高度 0 ~ h。
 * 外形必须落在这个包围盒里（误差 2 cm 以内），tests/furniture.test.ts 会逐个检查。
 * 摆到房间里的平移和旋转由 scene.ts 统一做，build() 不用管。
 */
import type * as THREE from "three";
import type { Materials } from "../materials";

export interface ItemStyle {
  /** 主体木色或柜体颜色（item.finish，没填就用主题的） */
  wood: THREE.Material;
  /** 同一木色深一档：脚、拉手、框 */
  woodDark: THREE.Material;
  /** 主布艺（item.color，没填就用主题的） */
  fabric: THREE.Material;
  /** 窗帘布（双面） */
  curtain: THREE.Material;
  /** 点缀布艺：抱枕、搭毯 */
  accent: THREE.Material;
}

export interface FurnitureCtx {
  g: THREE.Group;
  w: number;
  d: number;
  h: number;
  /** 已套上默认值的变体名 */
  variant: string;
  /** 家具底面到天花板的距离，吊灯拉线用 */
  ceil: number;
  /** 按家具 id 固定的随机数，同一件家具每次长得一样 */
  rand: () => number;
  style: ItemStyle;
  mat: Materials["mat"];
  clothCols: THREE.Material[];
}

export interface FurnitureDef {
  type: string;
  build(c: FurnitureCtx): void;
}
