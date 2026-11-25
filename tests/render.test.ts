import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import renderSrc from "../src/three/render.ts?raw";
import { outputSize, PRESETS } from "../src/ui/renderDialog";

describe("出效果图", () => {
  it("出图尺寸：长边定长、按画面宽高比算短边；竖屏时长边是高；全景宽是高的两倍", () => {
    expect(outputSize("still", 1280, 1280 / 952)).toEqual([1280, 952]);
    expect(outputSize("still", 1280, 0.7)).toEqual([896, 1280]);
    expect(outputSize("pano", 2048, 1.5)).toEqual([2048, 1024]);
  });
  it("清晰度预设：高清不比标准小，采样次数是正整数", () => {
    for (const k of ["still", "pano"] as const) {
      expect(PRESETS[k].hd.long).toBeGreaterThanOrEqual(PRESETS[k].std.long);
      for (const p of Object.values(PRESETS[k])) expect(Number.isInteger(p.samples) && p.samples > 0).toBe(true);
    }
  });
  it("渲染要用到的文件都在 public/render/ 里（改文件名时两边一起改）", () => {
    const names = [...renderSrc.matchAll(/ASSETS \+ "([^"]+)"/g)].map(m => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const n of names) expect(existsSync(`public/render/${n}`) && statSync(`public/render/${n}`).size > 1e5, `缺 public/render/${n}`).toBe(true);
    // 降噪权重是 Apache-2.0，再分发要带许可证原文
    expect(existsSync("public/render/LICENSE-oidn-weights.txt")).toBe(true);
  });
});
