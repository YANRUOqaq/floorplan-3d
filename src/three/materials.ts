/**
 * 材质和风格主题。
 *
 * 颜色说明：原 01 房页面用的 three.js r147 默认关闭色彩管理，十六进制颜色被直接当作线性值，
 * 画面因此偏亮。r152 以后默认开启色彩管理。为了让画面和原页面一致，这里的内置颜色用 legacy()
 * 按原来的方式解释；用户和大模型填的颜色（主题、家具 color、墙面和地板颜色）按正常的 sRGB 理解，
 * 填什么颜色显示出来就是什么颜色。
 */
import * as THREE from "three";
import type { House, Item, Room } from "../model/schema";
import { WOOD_FINISHES } from "../model/schema";
import { THEMES } from "../model/themes";
export { THEMES };
import { textures, FLOOR_GRAY } from "./textures";

/** 把十六进制数字直接当线性值（复现原页面的颜色） */
export function legacy(hex: string): THREE.Color {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Color().setRGB((n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, THREE.LinearSRGBColorSpace);
}
/** 用户颜色：标准 sRGB */
export const srgb = (hex: string) => new THREE.Color(hex);

type MatOpts = THREE.MeshStandardMaterialParameters;
export const M = (c: THREE.Color, o: MatOpts = {}) =>
  new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.8, metalness: 0, envMapIntensity: 0.5 }, o));

export type WoodFinish = (typeof WOOD_FINISHES)[number];

/** 家具木色。数值来自原页面（legacy），新加的胡桃木按同样方式取 */
const WOOD_HEX: Record<WoodFinish, string> = {
  oak: "#D8B993", oakLight: "#E4C99D", oakDark: "#A87D55", walnut: "#6E4B33",
  white: "#F6F5F1", black: "#2A2C2F", grey: "#C9CBCB",
};

export function createMaterials() {
  const t = textures();
  const wood = (c: THREE.Color, rough = 0.5) => M(c, { map: t.grain, bumpMap: t.grain, bumpScale: 0.3, roughness: rough });
  const fabric = (c: THREE.Color, o: MatOpts = {}) => M(c, Object.assign({ map: t.fabric, bumpMap: t.fabric, bumpScale: 0.6, roughness: 0.96 }, o));
  const L = legacy;
  const mat = {
    paint: M(L("#F5F3EF"), { map: t.paint, bumpMap: t.paint, bumpScale: 0.2, roughness: 0.92 }),
    ext: M(L("#E7E4DF"), { map: t.paint, roughness: 0.95 }),
    wallTile: M(L("#FFFFFF"), { map: t.wallTile, bumpMap: t.wallTile, bumpScale: 0.4, roughness: 0.1, envMapIntensity: 1 }),
    cutTop: M(L("#C9C4BC"), { roughness: 1 }),
    skirting: M(L("#B6AFA5"), { roughness: 0.3, envMapIntensity: 0.9 }),
    ceiling: M(L("#F8F7F4"), { roughness: 1, shadowSide: THREE.DoubleSide }),
    lamp: M(L("#FFFFFF"), { emissive: L("#FFF4E2"), emissiveIntensity: 0.35, roughness: 0.6 }),
    base: M(L("#CFCBC3"), { roughness: 1 }),
    door: wood(L("#5A3A2C"), 0.42),
    doorPanel: wood(L("#4E3226"), 0.42),
    entry: M(L("#44484C"), { roughness: 0.4, metalness: 0.4 }),
    frame: M(L("#2B2E31"), { roughness: 0.35, metalness: 0.55 }),
    glass: M(L("#DCE8EC"), { roughness: 0.02, transparent: true, opacity: 0.16, depthWrite: false, envMapIntensity: 1.3 }),
    steel: M(L("#C6CACD"), { roughness: 0.22, metalness: 0.9, envMapIntensity: 1 }),
    sill: M(L("#EFEDE8"), { roughness: 0.25, envMapIntensity: 0.9 }),
    lacquer: M(L("#F6F5F1"), { roughness: 0.3, envMapIntensity: 0.9 }),
    linen: fabric(L("#E8E1D4"), { side: THREE.DoubleSide }),
    sheer: M(L("#FBFAF7"), { roughness: 1, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    bed: fabric(L("#F7F5F0")),
    duvet: fabric(L("#EAE6DE")),
    black: M(L("#2A2C2F"), { roughness: 0.45, metalness: 0.2 }),
    screen: M(L("#0C0E11"), { roughness: 0.06, metalness: 0.3, envMapIntensity: 1.2 }),
    glow: M(L("#FFF8EC"), { emissive: L("#FFE6BF"), emissiveIntensity: 0.85, roughness: 1, side: THREE.DoubleSide }),
    rgb: M(L("#9DB2FF"), { emissive: L("#8BA6FF"), emissiveIntensity: 0.9 }),
    leaf: M(L("#55764A"), { roughness: 0.65, side: THREE.DoubleSide }),
    leaf2: M(L("#6A8B55"), { roughness: 0.65, side: THREE.DoubleSide }),
    trunk: M(L("#6E5A45"), { roughness: 0.9 }),
    soil: M(L("#4A3E33"), { roughness: 1 }),
    pot: M(L("#E6E1D8"), { roughness: 0.55 }),
    ceramic: M(L("#FAFAF8"), { roughness: 0.08, envMapIntensity: 1.1 }),
    granite: M(L("#FFFFFF"), { map: t.granite, roughness: 0.25, envMapIntensity: 1 }),
    sticker: M(L("#EFEEEA"), { roughness: 0.2, envMapIntensity: 1 }),
    bay: M(L("#3A3633"), { roughness: 0.95 }),
    foil: M(L("#D9DBDC"), { roughness: 0.45, metalness: 0.35 }),
    mirror: M(L("#EEF3F5"), { roughness: 0.02, metalness: 1, envMapIntensity: 1.2 }),
    tile: M(L("#FFFFFF"), { map: t.tile, roughness: 0.1, envMapIntensity: 1 }),
    tileSmall: M(L("#FFFFFF"), { map: t.tileSmall, roughness: 0.2, envMapIntensity: 0.9 }),
    deck: M(L("#FFFFFF"), { map: t.deck, bumpMap: t.deck, bumpScale: 1, roughness: 0.85 }),
    appliance: M(L("#EDEEEE"), { roughness: 0.25, envMapIntensity: 1 }),
    grey: M(L("#C9CBCB"), { roughness: 0.5 }),
    shadow: new THREE.MeshBasicMaterial({ map: t.blob, transparent: true, depthWrite: false, opacity: 0.5, color: 0x000000 }),
    edge: new THREE.MeshBasicMaterial({ map: t.edge, transparent: true, depthWrite: false, opacity: 0.24, color: 0x000000, side: THREE.DoubleSide }),
  };
  /** 衣服、书本这类小物件的杂色 */
  const clothCols = ["#3E4C60", "#ECE9E2", "#8E9289", "#CDBB9F", "#64705C", "#F3F0EA", "#34363A", "#AEB8C2", "#BC8E70"].map(c => fabric(L(c)));

  // 按需生成、按颜色缓存的材质
  const cache = new Map<string, THREE.Material>();
  const memo = <T extends THREE.Material>(key: string, make: () => T): T => {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key) as T;
  };
  const woodFinish = (f: WoodFinish) => memo("wood:" + f, () =>
    f === "white" ? mat.lacquer : f === "black" ? mat.black : f === "grey" ? mat.grey : wood(L(WOOD_HEX[f])));
  /** 同一木色再深一档（脚、拉手、木框） */
  const woodDark = (f: WoodFinish) => memo("woodDark:" + f, () => {
    if (f === "white" || f === "grey") return woodFinish("oak");
    if (f === "black") return mat.black;
    const c = L(WOOD_HEX[f]).multiplyScalar(0.72);
    return wood(c);
  });
  const fabricColor = (hex: string) => memo("fabric:" + hex, () => fabric(srgb(hex)));
  const curtainColor = (hex: string) => memo("curtain:" + hex, () => fabric(srgb(hex), { side: THREE.DoubleSide }));
  /** 地板：灰度纹理 × 颜色。颜色按 sRGB 理解，换算成线性后除以纹理的灰度 */
  const floorWood = (hex: string) => memo("floor:" + hex, () => {
    const g = new THREE.Color().setRGB(FLOOR_GRAY / 255, FLOOR_GRAY / 255, FLOOR_GRAY / 255, THREE.SRGBColorSpace);
    const c = srgb(hex);
    c.setRGB(c.r / g.r, c.g / g.g, c.b / g.b, THREE.LinearSRGBColorSpace);
    return M(c, { map: t.floor, bumpMap: t.floor, bumpScale: 0.6, roughness: 0.48, envMapIntensity: 0.85 });
  });
  const wallPaint = (hex: string) => memo("paint:" + hex, () => M(srgb(hex), { map: t.paint, bumpMap: t.paint, bumpScale: 0.2, roughness: 0.92 }));

  return { mat, clothCols, woodFinish, woodDark, fabricColor, curtainColor, floorWood, wallPaint, wood, fabric };
}
export type Materials = ReturnType<typeof createMaterials>;

/* ---------- 按主题和房间、家具的设置挑材质 ---------- */
export const themeOf = (h: House) => THEMES[h.theme] ?? THEMES.natural;

export function roomFloorMat(m: Materials, h: House, r: Room): THREE.Material {
  if (r.floor === "wood") return m.floorWood(r.floorColor ?? themeOf(h).floorColor);
  if (r.floor === "tile") return m.mat.tile;
  if (r.floor === "tileSmall") return m.mat.tileSmall;
  return m.mat.deck;
}
export function roomWallMat(m: Materials, h: House, r: Room | undefined): THREE.Material {
  if (!r || r.outdoor || r.wall === "exterior") return m.mat.ext;
  if (r.wall === "tile") return m.mat.wallTile;
  return m.wallPaint(r.wallColor ?? themeOf(h).wallColor);
}
export function itemStyle(m: Materials, h: House, it: Item) {
  const th = themeOf(h);
  const finish = it.finish ?? th.wood;
  return {
    wood: m.woodFinish(finish),
    woodDark: m.woodDark(finish),
    fabric: m.fabricColor(it.color ?? th.fabric),
    curtain: m.curtainColor(it.color ?? "#F5F1EB"),
    accent: m.fabricColor(th.accent),
  };
}
