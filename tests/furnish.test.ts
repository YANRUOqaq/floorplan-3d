import { describe, expect, it } from "vitest";
import example from "../examples/01-room.json";
import { furnishHouse, furnishRoom } from "../src/model/furnish";
import { convexOverlap, itemFootprint, wallFrame } from "../src/model/geometry";
import { applyOps, Op } from "../src/model/ops";
import { parseHouse, type House, type Opening, type Room, type Vec2 } from "../src/model/schema";

function shell(): House {
  const h = parseHouse(example);
  h.furniture = h.furniture.filter(f => f.fixed);
  h.extras = [];
  return h;
}

function apply(h: House, result = furnishHouse(h)) {
  result.ops.forEach(op => expect(Op.safeParse(op).success).toBe(true));
  const out = applyOps(h, result.ops);
  expect(out.errors).toEqual([]);
  expect(out.warnings).toEqual([]);
  return out.house;
}

function doorBlockers(h: House): string[] {
  const blockers: string[] = [];
  for (const wall of h.walls) for (const opening of wall.openings) {
    if (opening.type === "window") continue;
    const { d, n } = wallFrame(wall);
    for (const side of [-1, 1]) {
      const corners = [[0, 0], [opening.width, 0], [opening.width, 0.8], [0, 0.8]];
      const strip = corners.map(([u, v]): Vec2 => [
        wall.a[0] + d[0] * (opening.offset + u) + n[0] * side * (wall.thickness / 2 + v),
        wall.a[1] + d[1] * (opening.offset + u) + n[1] * side * (wall.thickness / 2 + v),
      ]);
      for (const f of h.furniture) {
        if (f.elevation || ["rug", "curtain"].includes(f.type)) continue;
        if (convexOverlap(itemFootprint(f), strip, 1e-6)) blockers.push(`${opening.id} / ${f.id} / ${side}`);
      }
    }
  }
  return blockers;
}

function room(type: Room["type"], polygon: Vec2[], openings: Record<number, Opening[]> = {}): House {
  return parseHouse({
    version: 1, name: "合成户型", rooms: [{ id: "room", name: "测试房间", type, polygon, floor: "wood", wall: "paint" }],
    walls: polygon.map((a, i) => ({
      id: "wall" + i, a, b: polygon[(i + 1) % polygon.length], thickness: 0.12, openings: openings[i] ?? [],
    })),
  });
}

const rectangle = (w: number, d: number): Vec2[] => [[0, 0], [w, 0], [w, d], [0, d]];
const door: Opening = { id: "door", type: "door", offset: 0.18, width: 0.8, side: -1, hinge: "a", bottom: 0, top: 2.05 };
const types = (h: House, id = "room") => h.furniture.filter(f => f.room === id).map(f => f.type);

describe("规则布置", () => {
  it("示例空壳可套用，各房间有基本家具并保留原有设施", () => {
    const initial = shell();
    const result = furnishHouse(initial);
    const h = apply(initial, result);
    expect(result.notes).toHaveLength(11);
    expect(new Set(result.ops.flatMap(op => op.op === "add" && op.ref ? [op.ref] : [])).size).toBe(result.ops.length);
    expect(types(h, "master")).toEqual(expect.arrayContaining(["bed", "nightstand", "curtain"]));
    expect(types(h, "gaming").some(t => ["bed", "single_bed"].includes(t))).toBe(true);
    const living = types(h, "living");
    expect(living.some(t => ["sofa", "sofa_l"].includes(t))).toBe(true);
    expect(living).toEqual(expect.arrayContaining(["coffee_table", "tv_stand", "tv", "dining_table"]));
    expect(living.filter(t => t === "chair").length).toBeGreaterThanOrEqual(2);
    expect(types(h, "kitchen")).toEqual(expect.arrayContaining(["stove", "fridge", "kitchen_counter"]));
    expect(types(h, "kitchen").filter(t => t === "kitchen_counter")).toHaveLength(1);
    expect(h.furniture.filter(f => f.room === "bath")).toEqual(initial.furniture.filter(f => f.room === "bath"));
    expect(types(h, "passage")).toContain("shoe_cabinet");
    expect(types(h, "util")).toContain("washer");
    expect(types(h, "balcony")).toEqual(expect.arrayContaining(["coffee_table", "stool"]));
    expect(types(h, "guest")).toContain("desk");
    expect(types(h, "guest").some(t => ["office_chair", "chair"].includes(t))).toBe(true);
  });

  it("示例所有新增家具都让开门两侧 0.8 m 的通道", () => {
    const initial = shell();
    // 原有洗手台已占用 d7 的通道，按接口必须保留原位。
    const existing = doorBlockers(initial);
    expect(existing).toEqual(["d7 / fx-basin / 1"]);
    expect(doorBlockers(apply(initial))).toEqual(existing);
  });

  it("已布置的示例再布置一次不新增家具", () => {
    expect(furnishHouse(apply(shell())).ops).toEqual([]);
  });

  it("空壳重复计算的指令相同，输入保持原样", () => {
    const h = shell(), before = structuredClone(h);
    expect(furnishHouse(h).ops).toEqual(furnishHouse(h).ops);
    expect(h).toEqual(before);
  });

  it("只布置指定房间，新增引用避开已有家具 id", () => {
    const h = shell();
    h.furniture[0].id = "furnish-1";
    const result = furnishRoom(h, "master");
    expect(result.ops.length).toBeGreaterThan(0);
    expect(result.ops.every(op => op.op === "add" && op.room === "master" && op.ref !== "furnish-1")).toBe(true);
    expect(result.notes).toHaveLength(1);
    apply(h, result);
  });

  it("3.3×3.9 m 卧室有衣柜，床头避开南窗", () => {
    const h = apply(room("bedroom", rectangle(3.3, 3.9), {
      0: [door], 2: [{ id: "window", type: "window", offset: 0.9, width: 1.5, bottom: 0.75, top: 2.35 }],
    }));
    const bed = h.furniture.find(f => ["bed", "single_bed"].includes(f.type));
    expect(bed).toBeDefined();
    expect(Math.abs(bed!.rot)).not.toBe(180);
    expect(types(h)).toContain("wardrobe");
    expect(doorBlockers(h)).toEqual([]);
  });

  it("L 形客厅有沙发且没有摆放问题", () => {
    const h = apply(room("living", [[0, 0], [5, 0], [5, 2.4], [3.6, 2.4], [3.6, 4.2], [0, 4.2]]));
    expect(types(h).some(t => ["sofa", "sofa_l"].includes(t))).toBe(true);
  });

  it("1.8×2.0 m 卧室不放双人床并说明原因", () => {
    const h = room("bedroom", rectangle(1.8, 2));
    const result = furnishHouse(h);
    expect(types(apply(h, result))).not.toContain("bed");
    expect(result.notes[0]).toMatch(/未放双人床|通道不足/);
  });

  it("2.0×3.0 m 卫生间有马桶、洗手台和淋浴", () => {
    const h = apply(room("bath", rectangle(2, 3), { 0: [door] }));
    expect(types(h)).toEqual(expect.arrayContaining(["toilet", "basin", "shower"]));
    expect(doorBlockers(h)).toEqual([]);
  });

  it("有余量的空厨房布置 L 形台面，灶具高于主台面底面一整段台面高", () => {
    const initial = room("kitchen", rectangle(3, 3), { 0: [door] });
    const h = apply(initial);
    const counters = h.furniture.filter(f => f.type === "kitchen_counter");
    expect(counters.map(f => f.variant)).toEqual(["sink-left", "none"]);
    expect(Math.abs((counters[0].rot - counters[1].rot) % 180)).toBe(90);
    const stove = h.furniture.find(f => f.type === "stove");
    expect(stove?.elevation).toBe(counters[0].size[2]);
    expect(types(h)).toContain("fridge");
    expect(doorBlockers(h)).toEqual([]);
    expect(furnishHouse(h).ops).toEqual([]);
  });

  it("示例空壳在 300 ms 内完成", () => {
    const h = shell();
    const start = performance.now();
    furnishHouse(h);
    expect(performance.now() - start).toBeLessThan(300);
  });
});

