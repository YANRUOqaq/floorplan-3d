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
  /**
   * 宽、深、高各自的常见范围（米），按国内市面上常见的规格定。
   * 大模型给的尺寸超出时改到范围边上（见 model/ops.ts 的 fitSize）；在属性面板里手动改不受限。
   * 家具外形按尺寸等比例拉伸，范围定得太宽，外形会变形（比如床头只有 30 cm 高时床垫被压得很薄）。
   */
  range: [[number, number], [number, number], [number, number]];
  /** floor：落地；onTop：放在别的家具上，用 elevation 指定底面高度；ceiling：吊在天花板下 */
  mount: Mount;
  /** 可选的外形变体，第一个是默认 */
  variants?: string[];
  /** 给大模型看的一句话说明 */
  hint?: string;
}

export const CATALOG: CatalogEntry[] = [
  { type: "bed", nameZh: "双人床", category: "床", defaultSize: [1.64, 2.08, 0.98], range: [[1.2, 2.3], [1.9, 2.3], [0.8, 1.3]], mount: "floor", hint: "w 是含床架的总宽，比床垫宽 10 到 15 cm（1.5 m 床垫的床约 1.64），d 是床长；床头在背面" },
  { type: "single_bed", nameZh: "单人床", category: "床", defaultSize: [0.95, 2.0, 0.8], range: [[0.8, 1.4], [1.9, 2.2], [0.6, 1.2]], mount: "floor", hint: "床头在背面" },
  { type: "folding_bed", nameZh: "折叠床", category: "床", defaultSize: [0.9, 0.3, 0.95], range: [[0.7, 1.3], [0.25, 2.0], [0.4, 1.1]], mount: "floor", variants: ["folded", "open"], hint: "folded 是收起立着；open 是展开，size 要改成约 [0.9, 1.9, 0.5]" },
  { type: "sofa", nameZh: "直排沙发", category: "坐具", defaultSize: [2.0, 0.9, 0.8], range: [[1.2, 3.6], [0.75, 1.1], [0.65, 1.0]], mount: "floor", hint: "靠背在背面" },
  { type: "sofa_l", nameZh: "转角沙发", category: "坐具", defaultSize: [2.3, 1.51, 0.7], range: [[1.8, 3.8], [1.3, 2.0], [0.6, 1.0]], mount: "floor", variants: ["right", "left"], hint: "贵妃位在正面看过去的右边（right）或左边（left），d 是含贵妃位的总进深" },
  { type: "armchair", nameZh: "单人沙发", category: "坐具", defaultSize: [0.8, 0.8, 0.8], range: [[0.6, 1.1], [0.6, 1.0], [0.6, 1.1]], mount: "floor" },
  { type: "chair", nameZh: "椅子", category: "坐具", defaultSize: [0.42, 0.42, 0.9], range: [[0.38, 0.65], [0.38, 0.65], [0.7, 1.1]], mount: "floor", hint: "餐椅、书桌椅；靠背在背面，正面朝桌子" },
  { type: "office_chair", nameZh: "办公椅", category: "坐具", defaultSize: [0.6, 0.6, 1.25], range: [[0.5, 0.75], [0.5, 0.75], [0.9, 1.4]], mount: "floor", hint: "靠背在背面，正面朝桌子" },
  { type: "stool", nameZh: "凳子", category: "坐具", defaultSize: [0.4, 0.4, 0.46], range: [[0.25, 0.5], [0.25, 0.5], [0.25, 0.8]], mount: "floor" },
  { type: "bench", nameZh: "长凳", category: "坐具", defaultSize: [0.8, 0.35, 0.45], range: [[0.6, 1.8], [0.3, 0.5], [0.38, 0.55]], mount: "floor", hint: "换鞋凳、床尾凳" },
  { type: "coffee_table", nameZh: "茶几", category: "桌几", defaultSize: [1.0, 0.5, 0.42], range: [[0.4, 1.6], [0.4, 1.0], [0.25, 0.75]], mount: "floor", variants: ["rect", "round"], hint: "round 时 w 和 d 都是直径" },
  { type: "dining_table", nameZh: "餐桌", category: "桌几", defaultSize: [1.2, 0.75, 0.75], range: [[0.6, 2.4], [0.6, 1.4], [0.7, 0.8]], mount: "floor", variants: ["rect", "round"] },
  { type: "desk", nameZh: "书桌/电脑桌", category: "桌几", defaultSize: [1.2, 0.6, 0.75], range: [[0.6, 2.4], [0.4, 0.9], [0.65, 0.8]], mount: "floor", hint: "人坐在正面一侧" },
  { type: "nightstand", nameZh: "床头柜", category: "柜架", defaultSize: [0.42, 0.42, 0.5], range: [[0.3, 0.7], [0.3, 0.5], [0.35, 0.7]], mount: "floor" },
  { type: "tv_stand", nameZh: "电视柜", category: "柜架", defaultSize: [1.6, 0.4, 0.47], range: [[0.8, 3.0], [0.3, 0.5], [0.3, 0.7]], mount: "floor" },
  { type: "wardrobe", nameZh: "衣柜", category: "柜架", defaultSize: [1.2, 0.58, 2.0], range: [[0.4, 3.0], [0.45, 0.65], [1.6, 2.7]], mount: "floor", hint: "门在正面" },
  { type: "clothes_rack", nameZh: "开放式衣帽架", category: "柜架", defaultSize: [1.0, 0.46, 2.1], range: [[0.4, 2.0], [0.3, 0.6], [1.2, 2.2]], mount: "floor", variants: ["shelves", "long"], hint: "shelves 带中间层板，long 是整根长挂" },
  { type: "shelf", nameZh: "置物架/书架", category: "柜架", defaultSize: [0.8, 0.3, 1.2], range: [[0.3, 2.0], [0.2, 0.45], [0.3, 2.2]], mount: "floor" },
  { type: "cabinet", nameZh: "抽屉柜/斗柜", category: "柜架", defaultSize: [0.8, 0.45, 0.9], range: [[0.4, 2.0], [0.3, 0.55], [0.5, 1.4]], mount: "floor", hint: "抽屉在正面，宽度大于 1 m 时自动分两列" },
  { type: "shoe_cabinet", nameZh: "鞋柜", category: "柜架", defaultSize: [1.0, 0.3, 1.1], range: [[0.4, 2.0], [0.2, 0.45], [0.4, 2.4]], mount: "floor" },
  { type: "floor_lamp", nameZh: "落地灯", category: "灯具", defaultSize: [0.42, 0.42, 1.62], range: [[0.2, 0.6], [0.2, 0.6], [1.2, 2.0]], mount: "floor" },
  { type: "table_lamp", nameZh: "台灯", category: "灯具", defaultSize: [0.26, 0.26, 0.36], range: [[0.12, 0.5], [0.12, 0.5], [0.2, 0.7]], mount: "onTop", hint: "elevation 设成下面那件家具的高度" },
  { type: "pendant_lamp", nameZh: "吊灯", category: "灯具", defaultSize: [0.46, 0.46, 0.4], range: [[0.15, 1.2], [0.15, 1.2], [0.1, 0.8]], mount: "ceiling", hint: "elevation 是灯罩底部离地高度，常用 1.6" },
  { type: "rug", nameZh: "地毯", category: "软装", defaultSize: [1.6, 2.3, 0.01], range: [[0.4, 4.0], [0.4, 4.0], [0.005, 0.03]], mount: "floor" },
  { type: "curtain", nameZh: "窗帘", category: "软装", defaultSize: [2.0, 0.1, 2.66], range: [[0.5, 6.0], [0.03, 0.2], [0.5, 3.2]], mount: "floor", variants: ["double", "blackout", "single"], hint: "挂在窗或门洞的室内一侧，正面朝屋里；double 是两侧布帘加中间纱帘" },
  { type: "plant", nameZh: "绿植", category: "软装", defaultSize: [0.5, 0.5, 1.5], range: [[0.2, 1.2], [0.2, 1.2], [0.2, 2.2]], mount: "floor" },
  { type: "mirror", nameZh: "落地镜", category: "软装", defaultSize: [0.54, 0.12, 1.64], range: [[0.3, 1.0], [0.03, 0.2], [0.6, 2.0]], mount: "floor", hint: "斜靠在墙上，背面贴墙" },
  { type: "deck_tiles", nameZh: "拼接木地板", category: "软装", defaultSize: [1.0, 1.0, 0.006], range: [[0.3, 8.0], [0.3, 8.0], [0.004, 0.04]], mount: "floor", hint: "阳台等处铺在原地面上" },
  { type: "fridge", nameZh: "冰箱", category: "电器", defaultSize: [0.65, 0.75, 1.75], range: [[0.5, 1.0], [0.55, 0.8], [0.8, 2.0]], mount: "floor" },
  { type: "washer", nameZh: "洗衣机", category: "电器", defaultSize: [0.6, 0.6, 0.85], range: [[0.55, 0.7], [0.45, 0.7], [0.8, 1.0]], mount: "floor" },
  { type: "tv", nameZh: "电视", category: "电器", defaultSize: [1.22, 0.2, 0.85], range: [[0.6, 2.3], [0.05, 0.4], [0.4, 1.5]], mount: "onTop", hint: "带底座，elevation 设成电视柜高度" },
  { type: "monitor", nameZh: "显示器", category: "电器", defaultSize: [0.64, 0.2, 0.6], range: [[0.3, 1.3], [0.1, 0.3], [0.3, 0.7]], mount: "onTop", hint: "elevation 设成桌面高度" },
  { type: "pc_tower", nameZh: "电脑主机", category: "电器", defaultSize: [0.24, 0.4, 0.46], range: [[0.15, 0.3], [0.3, 0.55], [0.3, 0.6]], mount: "floor" },
  { type: "stove", nameZh: "灶具", category: "厨卫", defaultSize: [0.7, 0.45, 0.05], range: [[0.6, 0.9], [0.35, 0.55], [0.02, 0.12]], mount: "onTop" },
  { type: "kitchen_counter", nameZh: "橱柜台面", category: "厨卫", defaultSize: [2.5, 0.6, 0.82], range: [[0.6, 5.0], [0.5, 0.7], [0.75, 0.95]], mount: "floor", variants: ["sink-left", "sink-right", "none"], hint: "水槽在正面看过去的左端或右端" },
  { type: "toilet", nameZh: "马桶", category: "厨卫", defaultSize: [0.42, 0.64, 0.8], range: [[0.35, 0.45], [0.5, 0.8], [0.6, 0.85]], mount: "floor", hint: "水箱在背面" },
  { type: "basin", nameZh: "洗手台", category: "厨卫", defaultSize: [0.45, 0.45, 0.86], range: [[0.35, 1.4], [0.35, 0.65], [0.75, 0.95]], mount: "floor" },
  { type: "shower", nameZh: "淋浴", category: "厨卫", defaultSize: [0.15, 0.15, 1.96], range: [[0.1, 0.4], [0.1, 0.4], [1.8, 2.3]], mount: "floor", hint: "背面贴墙" },
];

export const CATALOG_BY_TYPE: Record<string, CatalogEntry> = Object.fromEntries(CATALOG.map(c => [c.type, c]));
export const FURNITURE_TYPES = CATALOG.map(c => c.type) as [string, ...string[]];

/** 米换成厘米的文字：不到 10 cm 的保留一位小数（地毯厚 0.5 cm） */
export const cmText = (v: number) => { const c = v * 100; return String(c < 10 ? +c.toFixed(1) : Math.round(c)); };
/** “宽 130–230、深 190–230、高 80–130 cm”，提示词和尺寸被改时的说明都用它 */
export const rangeText = (c: CatalogEntry) => ["宽", "深", "高"].map((k, i) => `${k} ${cmText(c.range[i][0])}–${cmText(c.range[i][1])}`).join("、") + " cm";
