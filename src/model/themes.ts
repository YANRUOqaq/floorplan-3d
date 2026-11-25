/** 整体风格：决定没单独设颜色的家具木色、布艺颜色、墙面和地板颜色。颜色都是 sRGB。 */
import type { THEME_IDS, WOOD_FINISHES } from "./schema";

export type ThemeId = (typeof THEME_IDS)[number];
type WoodFinish = (typeof WOOD_FINISHES)[number];

export interface Theme {
  nameZh: string;
  desc: string;
  wood: WoodFinish;
  /** 布艺：沙发、床品、窗帘的主色 */
  fabric: string;
  /** 点缀布艺：抱枕、搭毯 */
  accent: string;
  wallColor: string;
  floorColor: string;
}
export const THEMES: Record<ThemeId, Theme> = {
  natural: { nameZh: "原木日式", desc: "橡木色家具、米白布艺、暖白墙", wood: "oak", fabric: "#EAE7E2", accent: "#CED5C5", wallColor: "#FBFAF8", floorColor: "#D0B08A" },
  nordic: { nameZh: "北欧白", desc: "浅木和白色为主，浅灰布艺", wood: "oakLight", fabric: "#E4E5E6", accent: "#B7C4CF", wallColor: "#FCFCFB", floorColor: "#DCCBB2" },
  cream: { nameZh: "奶油风", desc: "奶白和燕麦色，圆润柔和", wood: "oakLight", fabric: "#F2E9DA", accent: "#E6CFB0", wallColor: "#F6EFE4", floorColor: "#E2D0B6" },
  walnut: { nameZh: "胡桃木中古", desc: "深木色、焦糖和橄榄绿点缀", wood: "walnut", fabric: "#C9B79A", accent: "#8E9A6B", wallColor: "#F3EEE6", floorColor: "#9A7456" },
  industrial: { nameZh: "工业风", desc: "深木、黑色金属、灰色布艺", wood: "oakDark", fabric: "#9C9C99", accent: "#C08A5A", wallColor: "#E2E1DD", floorColor: "#8E857B" },
};

/*
 * 色板：大模型改颜色时只能从这里选名字，不能自己写色值（2026-11-24 实测，通义千问换“奶油风”时
 * 把 11 个房间的地板都设成了接近纯白的 #F8F5F0，整屋发白）。手动改颜色不受限。
 * 每个色板都包含 5 套风格用到的颜色（tests/model.test.ts 里检查），其余的是和这些风格搭得上的常见家装色。
 * 名字直接给大模型和用户看，所以用中文。
 */
/** 布艺：床品、沙发、椅垫、地毯、窗帘 */
export const FABRIC_COLORS = {
  米白: "#EAE7E2", 奶白: "#F2E9DA", 浅灰白: "#E4E5E6", 燕麦: "#D9C9AE", 驼色: "#C9B79A", 奶咖: "#E6CFB0",
  焦糖: "#C08A5A", 浅灰: "#CFCFCC", 中灰: "#9C9C99", 深灰: "#5E6063", 炭黑: "#34363A", 雾蓝: "#B7C4CF",
  藏青: "#3E4C60", 鼠尾草绿: "#CED5C5", 橄榄绿: "#8E9A6B", 墨绿: "#3F5546", 陶土红: "#A65E46", 豆沙粉: "#C9A3A0",
  芥末黄: "#C9A54A",
} as const;
/** 木地板 */
export const FLOOR_COLORS = {
  原木: "#D0B08A", 浅橡: "#DCCBB2", 奶油: "#E2D0B6", 灰橡: "#B9AE9F", 柚木: "#B08560", 胡桃: "#9A7456", 烟灰: "#8E857B", 深咖: "#6F5340",
} as const;
/** 乳胶漆墙面 */
export const WALL_COLORS = {
  暖白: "#FBFAF8", 纯白: "#FCFCFB", 奶油白: "#F6EFE4", 象牙白: "#F3EEE6", 浅灰: "#E2E1DD", 燕麦: "#EADFCF",
  暖灰: "#D9D3CA", 水泥灰: "#BDBAB4", 雾蓝: "#DCE3E8", 鼠尾草绿: "#DDE3D6", 豆沙粉: "#EDDCD6",
} as const;
export type Palette = Record<string, string>;
/** 色值在色板里的名字；不在色板里（用户自己调的颜色）返回 undefined */
export const colorName = (p: Palette, hex: string) => Object.keys(p).find(k => p[k].toUpperCase() === hex.toUpperCase());

