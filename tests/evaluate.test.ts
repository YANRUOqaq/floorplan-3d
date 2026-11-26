import { describe, expect, it } from "vitest";
import example from "../examples/01-room.json";
import { parseHouse, type Wall } from "../src/model/schema";
import { polygonIoU, scorePlan, wallCoverage } from "../src/model/evaluate";

const truth = parseHouse(example);
const move = (dx: number, dz: number, k = 1) => ({
  walls: truth.walls.map(w => ({ ...w, a: [w.a[0] * k + dx, w.a[1] * k + dz] as [number, number], b: [w.b[0] * k + dx, w.b[1] * k + dz] as [number, number], openings: w.openings.map(o => ({ ...o, offset: o.offset * k })) })),
  rooms: truth.rooms.map(r => ({ ...r, polygon: r.polygon.map(([x, z]) => [x * k + dx, z * k + dz] as [number, number]) })),
});

describe("识别评测", () => {
  it("和自己比：全对", () => {
    const s = scorePlan(truth, truth);
    expect(s.walls).toMatchObject({ truth: 24, within10: 24, within30: 24, extra: 0 });
    expect(s.openings.found).toBe(s.openings.truth);
    expect(s.rooms).toMatchObject({ truth: 11, found: 11, sameType: 11 });
  });
  it("整体平移了也能对齐：原点随便定都不影响", () => {
    const s = scorePlan(move(3.21, -1.7), truth);
    expect(s.offset[0]).toBeCloseTo(-3.21, 2);
    expect(s.offset[1]).toBeCloseTo(1.7, 2);
    expect(s.walls.within10).toBe(24);
    expect(s.rooms.found).toBe(11);
  });
  it("比例错 5% 要算错：不对齐缩放", () => {
    const s = scorePlan(move(0, 0, 1.05), truth);
    expect(s.walls.within10).toBeLessThan(12);
  });
  it("一面墙拆成两段照样算盖住", () => {
    const w = truth.walls.find(w => w.id === "w1")!;
    const mid: [number, number] = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    const halves: Wall[] = [{ ...w, b: mid }, { ...w, id: "x", a: mid }];
    expect(wallCoverage(w, halves, 0.1)).toBeCloseTo(1, 5);
    expect(wallCoverage(w, [halves[0]], 0.1)).toBeCloseTo(0.5, 5);
  });
  it("墙偏 20 cm：10 cm 内不算、30 cm 内算", () => {
    const shifted = { walls: truth.walls.map(w => w.id === "w17" ? { ...w, a: [w.a[0] + 0.2, w.a[1]] as [number, number], b: [w.b[0] + 0.2, w.b[1]] as [number, number] } : w), rooms: truth.rooms };
    const s = scorePlan(shifted, truth);
    expect(s.walls.within10).toBe(23);
    expect(s.walls.within30).toBe(24);
  });
  it("交并比", () => {
    const sq = (x: number, z: number, s: number) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]] as [number, number][];
    expect(polygonIoU(sq(0, 0, 2), sq(0, 0, 2))).toBeCloseTo(1, 2);
    expect(polygonIoU(sq(0, 0, 2), sq(1, 0, 2))).toBeCloseTo(1 / 3, 2);
    expect(polygonIoU(sq(0, 0, 1), sq(5, 5, 1))).toBe(0);
  });
});
