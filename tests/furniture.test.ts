/**
 * 家具库验收：每种家具、每个变体，按默认尺寸和改过的尺寸各建一次，检查
 * 1. 外形不超出 size 规定的包围盒（误差 2 cm），吊灯的吊线除外；
 * 2. 外形把包围盒“撑满”：每个方向至少占 85%，防止把尺寸写死在代码里；
 * 3. 吊灯的吊线正好拉到天花板。
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CATALOG } from "../src/model/catalog";
import { FURNITURE } from "../src/three/furniture";
import { rng } from "../src/three/textures";
import type { FurnitureCtx } from "../src/three/furniture/types";

const std = () => new THREE.MeshStandardMaterial();
const mat = new Proxy({} as Record<string, THREE.Material>, { get: (t, k: string) => (t[k] ??= std()) }) as unknown as FurnitureCtx["mat"];
const style = { wood: std(), woodDark: std(), fabric: std(), curtain: std(), accent: std() };
const clothCols = Array.from({ length: 9 }, std);

function build(type: string, variant: string, size: [number, number, number], ceil = 2.75) {
  const g = new THREE.Group();
  FURNITURE[type].build({ g, w: size[0], d: size[1], h: size[2], variant, ceil, rand: rng(1), style, mat, clothCols });
  g.updateMatrixWorld(true);
  const body = new THREE.Box3(), cord = new THREE.Box3();
  g.traverse(o => { if ((o as THREE.Mesh).isMesh) (o.userData.cord ? cord : body).expandByObject(o); });
  return { body, cord };
}

/** 折叠床展开后尺寸完全不同 */
const sizeFor = (type: string, variant: string): [number, number, number] =>
  type === "folding_bed" && variant === "open" ? [0.9, 1.9, 0.5] : CATALOG.find(c => c.type === type)!.defaultSize;

describe("家具库", () => {
  for (const c of CATALOG) for (const variant of c.variants ?? [""]) {
    const label = variant ? `${c.type}（${variant}）` : c.type;
    it(`${label} 已建模`, () => { expect(FURNITURE[c.type], `${c.type} 还没有建模`).toBeDefined(); });
    if (!FURNITURE[c.type]) continue;
    const base = sizeFor(c.type, variant);
    const sizes: [number, number, number][] = [base, [base[0] * 1.3, base[1] * 0.85, base[2] * 1.1]];
    for (const size of sizes) it(`${label} ${size.map(v => v.toFixed(2)).join("×")} 落在包围盒里并撑满`, () => {
      const [w, d, h] = size, tol = 0.02;
      const { body, cord } = build(c.type, variant, size);
      expect(body.isEmpty(), "没有生成任何网格").toBe(false);
      expect(body.min.x, "左边超出").toBeGreaterThanOrEqual(-w / 2 - tol);
      expect(body.max.x, "右边超出").toBeLessThanOrEqual(w / 2 + tol);
      expect(body.min.z, "背面超出").toBeGreaterThanOrEqual(-d / 2 - tol);
      expect(body.max.z, "正面超出").toBeLessThanOrEqual(d / 2 + tol);
      expect(body.min.y, "低于底面").toBeGreaterThanOrEqual(-tol);
      expect(body.max.y, "高于 h").toBeLessThanOrEqual(h + tol);
      expect(body.max.x - body.min.x, "宽度没撑满").toBeGreaterThanOrEqual(w * 0.85 - tol);
      expect(body.max.z - body.min.z, "进深没撑满").toBeGreaterThanOrEqual(d * 0.85 - tol);
      expect(body.max.y - body.min.y, "高度没撑满").toBeGreaterThanOrEqual(h * 0.85 - tol);
      if (c.mount === "ceiling") {
        expect(cord.isEmpty(), "吊灯要有吊线（userData.cord = true）").toBe(false);
        expect(cord.max.y).toBeCloseTo(2.75, 2);
      }
    });
  }

  it("同一件家具（同样的随机种子）每次建出来一样", () => {
    const a = build("clothes_rack", "long", [1, 0.46, 2.1]).body, b = build("clothes_rack", "long", [1, 0.46, 2.1]).body;
    expect(a.equals(b)).toBe(true);
  });
});
