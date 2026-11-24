/**
 * 家具目录：只有数据，没有 3D 代码。
 * 数据格式校验、2D 编辑器、发给大模型的提示词都从这里取家具类型和默认尺寸；
 * 3D 外形在 src/three/furniture/ 里按 type 一一对应。
 *
 * 尺寸约定 size = [w, d, h]（米）：w 是正面宽度，d 是进深（从背面到正面），h 是高度。
 * 朝向约定（rot 单位是度）：0 正面朝 +z（南），90 朝 +x（东），180 朝 -z（北），-90 朝 -x（西）。
 * 具体换算见 src/model/geometry.ts 的 itemFootprint()。
 */

export type Mount = "floor" | "wall" | "ceiling" | "onTop";
export type Category = "床" | "坐具" | "桌几" | "柜架" | "灯具" | "软装" | "厨卫" | "电器";

export interface CatalogEntry {
  type: string;
  nameZh: string;
  category: Category;
  defaultSize: [number, number, number];
  /** floor：落地；onTop：放在别的家具上，用 elevation 指定底面高度；ceiling：吊在天花板下 */
  mount: Mount;
  /** 可选的外形变体，第一个是默认 */
  variants?: string[];
  /** 给大模型看的一句话说明 */
  hint?: string;
}

export const CATALOG: CatalogEntry[] = [
  { type: "bed", nameZh: "双人床", category: "床", defaultSize: [1.64, 2.08, 0.98], mount: "floor", hint: "w 是床宽（含床架），d 是床长；床头在背面" },
  { type: "single_bed", nameZh: "单人床", category: "床", defaultSize: [0.95, 2.0, 0.8], mount: "floor", hint: "床头在背面" },
  { type: "folding_bed", nameZh: "折叠床", category: "床", defaultSize: [0.9, 0.3, 0.95], mount: "floor", variants: ["folded", "open"], hint: "folded 是收起立着；open 是展开，size 要改成约 [0.9, 1.9, 0.5]" },
  { type: "sofa", nameZh: "直排沙发", category: "坐具", defaultSize: [2.0, 0.9, 0.8], mount: "floor", hint: "靠背在背面" },
  { type: "sofa_l", nameZh: "转角沙发", category: "坐具", defaultSize: [2.3, 1.51, 0.7], mount: "floor", variants: ["right", "left"], hint: "贵妃位在正面看过去的右边（right）或左边（left），d 是含贵妃位的总进深" },
  { type: "armchair", nameZh: "单人沙发", category: "坐具", defaultSize: [0.8, 0.8, 0.8], mount: "floor" },
  { type: "chair", nameZh: "椅子", category: "坐具", defaultSize: [0.42, 0.42, 0.9], mount: "floor", hint: "餐椅、书桌椅；靠背在背面，正面朝桌子" },
  { type: "office_chair", nameZh: "办公椅", category: "坐具", defaultSize: [0.6, 0.6, 1.25], mount: "floor", hint: "靠背在背面，正面朝桌子" },
  { type: "stool", nameZh: "凳子", category: "坐具", defaultSize: [0.4, 0.4, 0.46], mount: "floor" },
  { type: "bench", nameZh: "长凳", category: "坐具", defaultSize: [0.8, 0.35, 0.45], mount: "floor", hint: "换鞋凳、床尾凳" },
  { type: "coffee_table", nameZh: "茶几", category: "桌几", defaultSize: [1.0, 0.5, 0.42], mount: "floor", variants: ["rect", "round"], hint: "round 时 w 和 d 都是直径" },
  { type: "dining_table", nameZh: "餐桌", category: "桌几", defaultSize: [1.2, 0.75, 0.75], mount: "floor", variants: ["rect", "round"] },
  { type: "desk", nameZh: "书桌/电脑桌", category: "桌几", defaultSize: [1.2, 0.6, 0.75], mount: "floor", hint: "人坐在正面一侧" },
  { type: "nightstand", nameZh: "床头柜", category: "柜架", defaultSize: [0.42, 0.42, 0.5], mount: "floor" },
  { type: "tv_stand", nameZh: "电视柜", category: "柜架", defaultSize: [1.6, 0.4, 0.47], mount: "floor" },
  { type: "wardrobe", nameZh: "衣柜", category: "柜架", defaultSize: [1.2, 0.58, 2.0], mount: "floor", hint: "门在正面" },
  { type: "clothes_rack", nameZh: "开放式衣帽架", category: "柜架", defaultSize: [1.0, 0.46, 2.1], mount: "floor", variants: ["shelves", "long"], hint: "shelves 带中间层板，long 是整根长挂" },
  { type: "shelf", nameZh: "置物架/书架", category: "柜架", defaultSize: [0.8, 0.3, 1.2], mount: "floor" },
  { type: "cabinet", nameZh: "抽屉柜/斗柜", category: "柜架", defaultSize: [0.8, 0.45, 0.9], mount: "floor", hint: "抽屉在正面，宽度大于 1 m 时自动分两列" },
  { type: "shoe_cabinet", nameZh: "鞋柜", category: "柜架", defaultSize: [1.0, 0.3, 1.1], mount: "floor" },
  { type: "floor_lamp", nameZh: "落地灯", category: "灯具", defaultSize: [0.42, 0.42, 1.62], mount: "floor" },
  { type: "table_lamp", nameZh: "台灯", category: "灯具", defaultSize: [0.26, 0.26, 0.36], mount: "onTop", hint: "elevation 设成下面那件家具的高度" },
  { type: "pendant_lamp", nameZh: "吊灯", category: "灯具", defaultSize: [0.46, 0.46, 0.4], mount: "ceiling", hint: "elevation 是灯罩底部离地高度，常用 1.6" },
  { type: "rug", nameZh: "地毯", category: "软装", defaultSize: [1.6, 2.3, 0.01], mount: "floor" },
  { type: "curtain", nameZh: "窗帘", category: "软装", defaultSize: [2.0, 0.1, 2.66], mount: "floor", variants: ["double", "blackout", "single"], hint: "挂在窗或门洞的室内一侧，正面朝屋里；double 是两侧布帘加中间纱帘" },
  { type: "plant", nameZh: "绿植", category: "软装", defaultSize: [0.5, 0.5, 1.5], mount: "floor" },
  { type: "mirror", nameZh: "落地镜", category: "软装", defaultSize: [0.54, 0.12, 1.64], mount: "floor", hint: "斜靠在墙上，背面贴墙" },
  { type: "deck_tiles", nameZh: "拼接木地板", category: "软装", defaultSize: [1.0, 1.0, 0.006], mount: "floor", hint: "阳台等处铺在原地面上" },
  { type: "fridge", nameZh: "冰箱", category: "电器", defaultSize: [0.65, 0.75, 1.75], mount: "floor" },
  { type: "washer", nameZh: "洗衣机", category: "电器", defaultSize: [0.6, 0.6, 0.85], mount: "floor" },
  { type: "tv", nameZh: "电视", category: "电器", defaultSize: [1.22, 0.2, 0.85], mount: "onTop", hint: "带底座，elevation 设成电视柜高度" },
  { type: "monitor", nameZh: "显示器", category: "电器", defaultSize: [0.64, 0.2, 0.6], mount: "onTop", hint: "elevation 设成桌面高度" },
  { type: "pc_tower", nameZh: "电脑主机", category: "电器", defaultSize: [0.24, 0.4, 0.46], mount: "floor" },
  { type: "stove", nameZh: "灶具", category: "厨卫", defaultSize: [0.7, 0.45, 0.05], mount: "onTop" },
  { type: "kitchen_counter", nameZh: "橱柜台面", category: "厨卫", defaultSize: [2.5, 0.6, 0.82], mount: "floor", variants: ["sink-left", "sink-right", "none"], hint: "水槽在正面看过去的左端或右端" },
  { type: "toilet", nameZh: "马桶", category: "厨卫", defaultSize: [0.42, 0.64, 0.8], mount: "floor", hint: "水箱在背面" },
  { type: "basin", nameZh: "洗手台", category: "厨卫", defaultSize: [0.45, 0.45, 0.86], mount: "floor" },
  { type: "shower", nameZh: "淋浴", category: "厨卫", defaultSize: [0.15, 0.15, 1.96], mount: "floor", hint: "背面贴墙" },
];

export const CATALOG_BY_TYPE: Record<string, CatalogEntry> = Object.fromEntries(CATALOG.map(c => [c.type, c]));
export const FURNITURE_TYPES = CATALOG.map(c => c.type) as [string, ...string[]];
