/**
 * house.json 的数据格式。整个项目只认这一份定义：
 * - 导入 JSON 时用 parseHouse() 校验，报错信息直接给用户看；
 * - TypeScript 类型从这里推出来（House、Wall……），代码里不再手写一遍；
 * - 发给大模型的格式说明也从这里生成。
 *
 * 坐标：单位米，x 向右（东），z 向下（南），y 向上。俯视图里就是“x 向右、z 向下”。
 */
import { z } from "zod";
import { FURNITURE_TYPES } from "./catalog";

export const Vec2 = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2>;
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色要写成 #RRGGBB");
const Id = z.string().min(1).max(40);

/* ---------- 材质和风格的可选值 ---------- */
export const FLOOR_FINISHES = ["wood", "tile", "tileSmall", "deck"] as const;
export const WALL_FINISHES = ["paint", "tile", "exterior"] as const;
export const WOOD_FINISHES = ["oak", "oakLight", "oakDark", "walnut", "white", "black", "grey"] as const;
export const THEME_IDS = ["natural", "nordic", "cream", "walnut", "industrial"] as const;
export const ROOM_TYPES = ["living", "dining", "bedroom", "study", "kitchen", "bath", "entry", "hall", "storage", "balcony", "other"] as const;

export const FLOOR_LABEL: Record<(typeof FLOOR_FINISHES)[number], string> = { wood: "木地板", tile: "大瓷砖", tileSmall: "小瓷砖", deck: "防腐木" };
export const WALL_LABEL: Record<(typeof WALL_FINISHES)[number], string> = { paint: "乳胶漆", tile: "墙砖", exterior: "外墙涂料" };
export const WOOD_LABEL: Record<(typeof WOOD_FINISHES)[number], string> = { oak: "橡木", oakLight: "浅橡木", oakDark: "深橡木", walnut: "胡桃木", white: "白色", black: "黑色", grey: "灰色" };
export const ROOM_LABEL: Record<(typeof ROOM_TYPES)[number], string> = {
  living: "客厅", dining: "餐厅", bedroom: "卧室", study: "书房", kitchen: "厨房", bath: "卫生间",
  entry: "玄关", hall: "过道", storage: "储物间", balcony: "阳台", other: "其他",
};

/* ---------- 墙和门窗 ---------- */
export const OPENING_TYPES = ["door", "entry", "sliding", "window", "opening"] as const;
export const OPENING_LABEL: Record<(typeof OPENING_TYPES)[number], string> = { door: "平开门", entry: "入户门", sliding: "推拉门", window: "窗", opening: "门洞" };

export const Opening = z.object({
  id: Id,
  type: z.enum(OPENING_TYPES),
  /** 洞口起点到墙 a 端的距离 */
  offset: z.number().min(0),
  width: z.number().positive(),
  /** 洞口下沿、上沿离地高度。门的 bottom 是 0 */
  bottom: z.number().min(0),
  top: z.number().positive(),
  /** 平开门：门轴在洞口靠 a 端还是 b 端 */
  hinge: z.enum(["a", "b"]).optional(),
  /** 平开门往哪一侧开：1 = 沿 a→b 方向看的左手边，-1 = 右手边 */
  side: z.union([z.literal(1), z.literal(-1)]).optional(),
  /** 推拉门扇数 */
  panels: z.number().int().min(1).max(6).optional(),
  /** 窗：室内一侧加护栏 */
  rail: z.boolean().optional(),
});
export type Opening = z.infer<typeof Opening>;

export const Wall = z.object({
  id: Id,
  a: Vec2,
  b: Vec2,
  thickness: z.number().min(0.03).max(1),
  /** 不填就是层高 */
  height: z.number().positive().optional(),
  /** wall：普通墙；parapet：矮墙（实心）；railing：栏板（下半实心、上半栏杆） */
  kind: z.enum(["wall", "parapet", "railing"]).default("wall"),
  openings: z.array(Opening).default([]),
});
export type Wall = z.infer<typeof Wall>;

/* ---------- 房间 ---------- */
export const Room = z.object({
  id: Id,
  name: z.string().min(1),
  type: z.enum(ROOM_TYPES),
  /** 按墙中线描的多边形，顺时针逆时针都行 */
  polygon: z.array(Vec2).min(3),
  floor: z.enum(FLOOR_FINISHES),
  floorColor: Hex.optional(),
  wall: z.enum(WALL_FINISHES),
  wallColor: Hex.optional(),
  /** 室外（阳台、生活阳台）：没有墙根暗角，墙面用外墙涂料 */
  outdoor: z.boolean().optional(),
});
export type Room = z.infer<typeof Room>;

/** 房间类型的默认地面和墙面 */
export function roomDefaults(type: Room["type"]): Pick<Room, "floor" | "wall" | "outdoor"> {
  if (type === "kitchen" || type === "bath") return { floor: "tileSmall", wall: "tile", outdoor: undefined };
  if (type === "balcony") return { floor: "tile", wall: "exterior", outdoor: true };
  return { floor: "wood", wall: "paint", outdoor: undefined };
}

/* ---------- 家具 ---------- */
export const Item = z.object({
  id: Id,
  type: z.enum(FURNITURE_TYPES),
  name: z.string().optional(),
  /** 规格说明，显示在清单里 */
  spec: z.string().optional(),
  room: Id.optional(),
  /** 占地中心 */
  pos: Vec2,
  /** 度：0 正面朝南（+z），90 朝东，180 朝北，-90 朝西 */
  rot: z.number().default(0),
  /** [宽, 深, 高]，米 */
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  /** 底面离地高度：放在桌上的台灯、吊灯用 */
  elevation: z.number().min(0).optional(),
  variant: z.string().optional(),
  /** 木色或柜体颜色 */
  finish: z.enum(WOOD_FINISHES).optional(),
  /** 布艺颜色 */
  color: Hex.optional(),
  /** 房子原有的设施（马桶、台面等），不计预算，大模型不能移动或删除 */
  fixed: z.boolean().optional(),
  price: z.number().min(0).optional(),
  /** user：自己填的；llm：大模型估的，没有核实 */
  priceBasis: z.enum(["user", "llm"]).optional(),
  optional: z.boolean().optional(),
  note: z.string().optional(),
});
export type Item = z.infer<typeof Item>;

/** 清单里不对应 3D 物体的项目：床垫、地板材料、运费等 */
export const Extra = z.object({
  id: Id,
  name: z.string().min(1),
  spec: z.string().optional(),
  room: Id.optional(),
  price: z.number().min(0),
  priceBasis: z.enum(["user", "llm"]).optional(),
  optional: z.boolean().optional(),
  note: z.string().optional(),
});
export type Extra = z.infer<typeof Extra>;

/** 描图底图的标定：图片本身存在浏览器的 IndexedDB 里，不写进 JSON */
export const Background = z.object({
  /** 图上横向 1 米对应多少像素 */
  pxPerM: z.number().positive(),
  /** 图上纵向 1 米对应多少像素。手机拍的户型图常被拉伸，横竖比例不同；不填就和横向一样，也表示还没单独标定过 */
  pxPerMz: z.number().positive().optional(),
  /** 坐标原点 (0,0) 在图上的像素位置 */
  origin: Vec2,
  opacity: z.number().min(0).max(1).default(0.5),
});
export type Background = z.infer<typeof Background>;

export const HouseBase = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  /** 层高 */
  height: z.number().min(2).max(6).default(2.75),
  theme: z.enum(THEME_IDS).default("natural"),
  budget: z.object({ min: z.number().min(0).optional(), max: z.number().min(0).optional() }).optional(),
  walls: z.array(Wall),
  rooms: z.array(Room),
  furniture: z.array(Item).default([]),
  extras: z.array(Extra).default([]),
  background: Background.optional(),
});

/** 字段之间的检查：id 不重复、引用的房间存在、洞口不超出墙 */
export const House = HouseBase.superRefine((h, ctx) => {
  const seen = new Map<string, string>();
  const claim = (id: string, path: (string | number)[]) => {
    if (seen.has(id)) ctx.addIssue({ code: "custom", path, message: `id "${id}" 重复了（和 ${seen.get(id)} 同名）` });
    else seen.set(id, path.join("."));
  };
  h.walls.forEach((w, i) => {
    claim(w.id, ["walls", i, "id"]);
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (len < 0.05) ctx.addIssue({ code: "custom", path: ["walls", i], message: `墙 ${w.id} 太短（${len.toFixed(3)} m）` });
    const wh = w.height ?? h.height;
    w.openings.forEach((o, j) => {
      claim(o.id, ["walls", i, "openings", j, "id"]);
      if (o.offset + o.width > len + 1e-6) ctx.addIssue({ code: "custom", path: ["walls", i, "openings", j], message: `洞口 ${o.id} 超出了墙 ${w.id}：offset + width = ${(o.offset + o.width).toFixed(3)}，墙长 ${len.toFixed(3)}` });
      if (o.top <= o.bottom) ctx.addIssue({ code: "custom", path: ["walls", i, "openings", j], message: `洞口 ${o.id} 的上沿要高于下沿` });
      if (o.top > wh + 1e-6) ctx.addIssue({ code: "custom", path: ["walls", i, "openings", j], message: `洞口 ${o.id} 的上沿 ${o.top} 高过了墙高 ${wh}` });
    });
  });
  const roomIds = new Set<string>();
  h.rooms.forEach((r, i) => { claim(r.id, ["rooms", i, "id"]); roomIds.add(r.id); });
  h.furniture.forEach((f, i) => {
    claim(f.id, ["furniture", i, "id"]);
    if (f.room && !roomIds.has(f.room)) ctx.addIssue({ code: "custom", path: ["furniture", i, "room"], message: `家具 ${f.id} 所在的房间 "${f.room}" 不存在` });
  });
  h.extras.forEach((e, i) => {
    claim(e.id, ["extras", i, "id"]);
    if (e.room && !roomIds.has(e.room)) ctx.addIssue({ code: "custom", path: ["extras", i, "room"], message: `清单项 ${e.id} 所在的房间 "${e.room}" 不存在` });
  });
});
export type House = z.infer<typeof House>;

/** 校验并补默认值；失败时抛出的错误信息逐条列出出错位置 */
export function parseHouse(data: unknown): House {
  const r = House.safeParse(data);
  if (r.success) return r.data;
  throw new Error("户型数据有问题：\n" + formatIssues(r.error));
}

export function formatIssues(err: z.ZodError): string {
  return err.issues.slice(0, 12).map(i => `- ${i.path.join(".") || "(根)"}：${i.message}`).join("\n") +
    (err.issues.length > 12 ? `\n……还有 ${err.issues.length - 12} 处` : "");
}

/** 新建一个空方案 */
export function emptyHouse(name = "我的家"): House {
  return parseHouse({ version: 1, name, walls: [], rooms: [] });
}
