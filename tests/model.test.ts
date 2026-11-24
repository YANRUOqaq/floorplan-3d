import { describe, expect, it } from "vitest";
import example from "../examples/01-room.json";
import { parseHouse, type House } from "../src/model/schema";
import { CATALOG } from "../src/model/catalog";
import {
  centroid, convexOverlap, itemFootprint, labelPoint, makeWalkable, pointInPolygon, polygonArea,
  roomDoors, autoRoomView, wallPieces, wallSplits, wallPoint, wallFrame,
} from "../src/model/geometry";

const house = parseHouse(example);
const clone = (): any => JSON.parse(JSON.stringify(example));

describe("数据格式", () => {
  it("01 房示例能通过校验，数量和原页面一致", () => {
    expect(house.walls.length).toBe(24);
    expect(house.rooms.length).toBe(11);
    expect(house.furniture.length).toBe(56);
  });

  it("示例的预算合计和原页面 README 一致（必买 17943，可选 2790）", () => {
    const lines = [...house.furniture.filter(f => f.price != null), ...house.extras];
    const req = lines.filter(l => !l.optional).reduce((s, l) => s + (l.price ?? 0), 0);
    const opt = lines.filter(l => l.optional).reduce((s, l) => s + (l.price ?? 0), 0);
    expect(req).toBe(17943);
    expect(opt).toBe(2790);
  });

  it("id 重复会报错并指出位置", () => {
    const d = clone(); d.rooms[1].id = d.rooms[0].id;
    expect(() => parseHouse(d)).toThrow(/重复/);
  });

  it("洞口超出墙会报错", () => {
    const d = clone(); d.walls[1].openings[0].width = 5;
    expect(() => parseHouse(d)).toThrow(/超出了墙/);
  });

  it("家具类型不在目录里会报错", () => {
    const d = clone(); d.furniture[0].type = "spaceship";
    expect(() => parseHouse(d)).toThrow();
  });

  it("引用不存在的房间会报错", () => {
    const d = clone(); d.furniture[0].room = "nowhere";
    expect(() => parseHouse(d)).toThrow(/不存在/);
  });

  it("缺省字段补上默认值", () => {
    const h = parseHouse({ version: 1, name: "x", walls: [{ id: "w", a: [0, 0], b: [3, 0], thickness: 0.2 }], rooms: [] });
    expect(h.height).toBe(2.75);
    expect(h.walls[0].kind).toBe("wall");
    expect(h.walls[0].openings).toEqual([]);
    expect(h.furniture).toEqual([]);
  });

  it("目录里的类型没有重复，默认尺寸都是正数", () => {
    expect(new Set(CATALOG.map(c => c.type)).size).toBe(CATALOG.length);
    for (const c of CATALOG) expect(c.defaultSize.every(v => v > 0)).toBe(true);
  });
});

describe("几何", () => {
  it("房间面积和原页面 REG 矩形一致", () => {
    const area = (id: string) => polygonArea(house.rooms.find(r => r.id === id)!.polygon);
    expect(area("living")).toBeCloseTo(3.75 * 6.25, 6);
    expect(area("master")).toBeCloseTo(2.85 * 4.3, 6);
    expect(area("gaming")).toBeCloseTo(2.65 * 3.13, 6);
  });

  it("L 形房间的标签点落在房间里", () => {
    const L: [number, number][] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
    expect(pointInPolygon(centroid(L), L)).toBe(false);
    expect(pointInPolygon(labelPoint(L), L)).toBe(true);
  });

  it("墙的局部坐标：法线是沿 a→b 看的左手边", () => {
    const w = { id: "w", a: [0, 0] as [number, number], b: [2, 0] as [number, number], thickness: 0.2, kind: "wall" as const, openings: [] };
    expect(wallFrame(w).n[0]).toBeCloseTo(0, 9); expect(wallFrame(w).n[1]).toBe(-1);
    expect(wallPoint(w, 1, 0.5)).toEqual([1, -0.5]);
  });

  it("墙按洞口切段：门上方、窗下方和窗上方都留墙", () => {
    const w = house.walls.find(w => w.openings.some(o => o.id === "win12"))!;   // 南墙两扇窗
    const pieces = wallPieces(w, 2.75);
    expect(pieces).toContainEqual([0.6, 2.1, 0, 0.6]);
    expect(pieces).toContainEqual([0.6, 2.1, 2.3, 2.75]);
    expect(pieces.filter(p => p[2] === 0 && p[3] === 2.75).length).toBe(3);
  });

  it("墙在房间边界处切段（主卧和衣帽间的南墙）", () => {
    const w = house.walls.find(w => w.a[0] === 3.75 && w.a[1] === 10.15 && w.b[0] === 9.25)!;
    expect(wallSplits(w, house.rooms)).toContain(2.65);   // x = 6.4
  });

  it("家具占地：rot=90 时正面朝东，宽度沿南北方向", () => {
    const fp = itemFootprint({ pos: [0, 0], rot: 90, size: [2, 1, 1] });
    const xs = fp.map(p => p[0]), zs = fp.map(p => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1, 6);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(2, 6);
    expect(fp[3][0]).toBeCloseTo(0.5, 6);   // 左前角在东侧
  });

  it("凸多边形重叠判断", () => {
    const a = itemFootprint({ pos: [0, 0], rot: 0, size: [1, 1, 1] });
    expect(convexOverlap(a, itemFootprint({ pos: [0.9, 0], rot: 45, size: [1, 1, 1] }))).toBe(true);
    expect(convexOverlap(a, itemFootprint({ pos: [1.2, 0], rot: 0, size: [1, 1, 1] }))).toBe(false);
    expect(convexOverlap(a, itemFootprint({ pos: [1.0, 0], rot: 0, size: [1, 1, 1] }))).toBe(false);   // 只是贴边
  });
});

describe("能不能走", () => {
  const walk = makeWalkable(house);
  it("房间中间能站", () => { expect(walk(1.9, 6.5)).toBe(true); expect(walk(7.8, 8)).toBe(true); });
  it("墙边 20 cm 以内不能站", () => { expect(walk(3.75 - 0.06 - 0.15, 8)).toBe(false); expect(walk(3.75 - 0.06 - 0.25, 8)).toBe(true); });
  it("户外不能站", () => { expect(walk(-1, 5)).toBe(false); expect(walk(12, 5)).toBe(false); });
  it("平开门的门洞里能过，入户门关着不能过", () => {
    expect(walk(6.4, 6.45)).toBe(true);         // 主卧门洞（墙 x=6.4，z 6.0~6.9）
    expect(walk(0.75, 0)).toBe(false);          // 入户门
  });
  it("窗下是实墙，不能穿过去", () => { expect(walk(5.1, 10.15)).toBe(false); });
  it("家具占地不能站", () => {
    expect(walk(1.9, 6.5, [{ r: [1.5, 2.5, 6, 7] }])).toBe(false);
    expect(walk(1.9, 6.5, [{ r: [1.5, 2.5, 6, 7], active: () => false }])).toBe(true);
  });
});

describe("自动视角", () => {
  const walk = makeWalkable(house);
  it("每个室内房间都能找到能站的视角", () => {
    for (const r of house.rooms.filter(r => !r.outdoor && r.id !== "niche")) {
      const v = autoRoomView(house, r, walk);
      expect(walk(v.at[0], v.at[1]), r.name).toBe(true);
      expect(pointInPolygon(v.at, r.polygon), r.name).toBe(true);
    }
  });
  it("主卧的门找得到，朝向屋里", () => {
    const master = house.rooms.find(r => r.id === "master")!;
    const d = roomDoors(house, master);
    expect(d.length).toBe(1);
    expect(d[0].inward[0]).toBeCloseTo(1, 6);
  });
});

// 类型检查用：确保 JSON 导入后的类型和 House 兼容
const _typed: House = house;
void _typed;
