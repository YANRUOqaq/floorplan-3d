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

