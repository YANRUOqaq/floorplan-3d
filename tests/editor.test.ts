import { describe, expect, it } from "vitest";
import { nearestWall, placeOnWall, snap } from "../src/editor/snap";
import { parseHouse } from "../src/model/schema";
import { Store } from "../src/model/store";
import type { Vec2 } from "../src/model/schema";

describe("描图吸附", () => {
  const targets: Vec2[] = [[0, 0], [3.75, 0], [3.75, 5.85]];
  it("靠近已有端点时吸到端点上", () => {
    expect(snap([3.71, 0.03], targets, null, 0.1).p).toEqual([3.75, 0]);
  });
  it("和上一个点接近水平时拉平", () => {
    const r = snap([2.0, 0.12], targets, [0, 0], 0.05);
    expect(r.kind).toBe("ortho"); expect(r.p[1]).toBe(0);
  });
  it("按住 Shift 不拉平，只按 1 cm 取整", () => {
    expect(snap([2.0, 0.123], targets, [0, 0], 0.05, true).p).toEqual([2, 0.12]);
  });
  it("对齐别的端点的 x，给出辅助线", () => {
    const r = snap([3.73, 3.0], targets, null, 0.05);
    expect(r.p[0]).toBe(3.75); expect(r.guides.length).toBeGreaterThan(0);
  });
  it("门窗放在墙上不超出墙", () => {
    expect(placeOnWall(3, 0.1, 0.9)).toEqual({ offset: 0, width: 0.9 });
    expect(placeOnWall(3, 2.95, 0.9)).toEqual({ offset: 2.1, width: 0.9 });
    expect(placeOnWall(0.6, 0.3, 0.9).width).toBeCloseTo(0.5, 6);   // 墙比门还短：门收窄
  });
  it("找鼠标附近的墙", () => {
    const h = parseHouse({ version: 1, name: "t", walls: [{ id: "w", a: [0, 0], b: [4, 0], thickness: 0.2 }], rooms: [] });
    expect(nearestWall(h, [2, 0.12], 0.05)?.id).toBe("w");
    expect(nearestWall(h, [2, 0.3], 0.05)).toBeNull();
  });
});

describe("撤销和自动保存", () => {
  it("每次修改都能撤销、重做，并写进存储", () => {
    const saved: Record<string, string> = {};
    const storage = { getItem: (k: string) => saved[k] ?? null, setItem: (k: string, v: string) => { saved[k] = v; } };
    const s = new Store(parseHouse({ version: 1, name: "a", walls: [], rooms: [] }), storage);
    s.commit("改名", d => { d.name = "b"; });
    s.commit("改名", d => { d.name = "c"; });
    expect(Store.restore(storage)?.name).toBe("c");
    s.undo(); expect(s.house.name).toBe("b");
    s.undo(); expect(s.house.name).toBe("a"); expect(s.canUndo).toBe(false);
    s.redo(); expect(s.house.name).toBe("b");
    s.commit("改名", d => { d.name = "x"; }); expect(s.canRedo).toBe(false);
  });
  it("不合格的修改不生效", () => {
    const s = new Store(parseHouse({ version: 1, name: "a", walls: [], rooms: [] }));
    expect(() => s.commit("坏", d => { (d as { height: number }).height = -1; })).toThrow();
    expect(s.house.height).toBe(2.75); expect(s.canUndo).toBe(false);
  });
});
