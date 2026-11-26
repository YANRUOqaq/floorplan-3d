import { existsSync } from "node:fs";
import { pngGray } from "./png";
import { expect, it } from "vitest";
import example from "../examples/01-room.json";
import { itemFootprint, pointInPolygon, wallFrame } from "../src/model/geometry";
import { detectPlan, type Gray, type PxWall } from "../src/model/raster";
import { parseHouse, type House, type Vec2, type Wall } from "../src/model/schema";

const house = parseHouse(example);

function draw(plan: House, scale: number, w: number, h: number, distractions: boolean) {
  const img: Gray = { w, h, data: new Uint8Array(w * h).fill(255) };
  const pixel = ([x, y]: Vec2): Vec2 => [60 + x * scale, 70 + y * scale];
  const paint = (x: number, y: number, gray: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) img.data[y * w + x] = Math.min(img.data[y * w + x], gray);
  };
  const line = (a: Vec2, b: Vec2, gray = 30, width = 1) => {
    const steps = Math.ceil(2 * Math.hypot(b[0] - a[0], b[1] - a[1]));
    for (let i = 0; i <= steps; i++) {
      const f = steps ? i / steps : 0;
      const x = Math.floor(a[0] + (b[0] - a[0]) * f);
      const y = Math.floor(a[1] + (b[1] - a[1]) * f);
      for (let dx = 0; dx < width; dx++) for (let dy = 0; dy < width; dy++) paint(x + dx, y + dy, gray);
    }
  };
  const rectangle = (a: Vec2, b: Vec2) => {
    for (let y = Math.round(Math.min(a[1], b[1])); y < Math.round(Math.max(a[1], b[1])); y++) {
      for (let x = Math.round(Math.min(a[0], b[0])); x < Math.round(Math.max(a[0], b[0])); x++) paint(x, y, 35);
    }
  };

  for (const f of plan.furniture) {
    const points = itemFootprint(f).map(pixel);
    points.forEach((p, i) => line(p, points[(i + 1) % points.length], 160));
  }
  const expected: { point: Vec2; type: string }[] = [];
  for (const wall of plan.walls) {
    const { len, d, n } = wallFrame(wall);
    const at = (u: number, v = 0) => pixel([wall.a[0] + d[0] * u + n[0] * v, wall.a[1] + d[1] * u + n[1] * v]);
    const t = wall.thickness / 2;
    const segment = (lo: number, hi: number) => {
      if (wall.kind === "railing") {
        for (const side of [-t, t]) line(at(lo, side), at(hi, side));
      } else rectangle(at(lo, -t), at(hi, t));
    };
    let from = 0;
    for (const opening of wall.openings) {
      const { offset: lo, width, type } = opening;
      const hi = lo + width;
      segment(from, lo);
      from = hi;
      expected.push({ point: at((lo + hi) / 2), type });
      if (type === "window") {
        for (const v of [-t * 0.55, t * 0.55]) line(at(lo, v), at(hi, v));
      } else if (type === "sliding") {
        line(at(lo, -t * 0.45), at(lo + width * 0.55, -t * 0.45));
        line(at(lo + width * 0.45, t * 0.45), at(hi, t * 0.45));
      } else if (type === "door" || type === "entry") {
        const hinge = opening.hinge === "b" ? hi : lo;
        const swing = hinge === lo ? 1 : -1;
        const side = opening.side ?? 1;
        line(at(hinge, side * t), at(hinge, side * (t + width)));
        let prev = at(hinge + swing * width, side * t);
        for (let i = 1; i <= 48; i++) {
          const angle = i * Math.PI / 96;
          const next = at(hinge + swing * width * Math.cos(angle), side * (t + width * Math.sin(angle)));
          line(prev, next);
          prev = next;
        }
      }
    }
    segment(from, len);
  }

  if (distractions) {
    for (const r of plan.rooms) {
      const count = r.polygon.length;
      const center = pixel([r.polygon.reduce((sum, p) => sum + p[0], 0) / count, r.polygon.reduce((sum, p) => sum + p[1], 0) / count]);
      for (const dx of [-12, 0, 12]) {
        line([center[0] + dx, center[1] - 4], [center[0] + dx + 7, center[1] - 4], 35, 2);
        line([center[0] + dx + 3, center[1] - 6], [center[0] + dx + 3, center[1] + 3], 35, 2);
      }
      const stroke = Math.round(scale * 0.1);
      rectangle([center[0] - stroke, center[1] + 8], [center[0] + stroke, center[1] + 8 + stroke]);
    }
    const xs = plan.walls.flatMap(s => [pixel(s.a)[0], pixel(s.b)[0]]);
    const ys = plan.walls.flatMap(s => [pixel(s.a)[1], pixel(s.b)[1]]);
    for (const y of [Math.min(...ys) - 23, Math.max(...ys) + 23]) {
      line([Math.min(...xs), y], [Math.max(...xs), y]);
      for (const x of new Set(xs)) line([x - 4, y + 4], [x + 4, y - 4]);
    }
    for (const x of [Math.min(...xs) - 23, Math.max(...xs) + 23]) {
      line([x, Math.min(...ys)], [x, Math.max(...ys)]);
      for (const y of new Set(ys)) line([x - 4, y + 4], [x + 4, y - 4]);
    }
  }
  return { img, pixel, expected };
}

function comparable(a: PxWall, b: PxWall, tolerance = 1.5) {
  const axis = a.a[1] === a.b[1] ? 0 : 1;
  return b.a[1 - axis] === b.b[1 - axis] && Math.abs(a.a[1 - axis] - b.a[1 - axis]) <= tolerance
    ? Math.max(0, Math.min(a.b[axis], b.b[axis]) - Math.max(a.a[axis], b.a[axis])) : 0;
}

function covered(wall: PxWall, segments: PxWall[], tolerance = 1.5) {
  const axis = wall.a[1] === wall.b[1] ? 0 : 1;
  const spans = segments.filter(s => comparable(wall, s, tolerance) > 0)
    .map(s => [Math.max(wall.a[axis], s.a[axis]), Math.min(wall.b[axis], s.b[axis])])
    .sort((a, b) => a[0] - b[0]);
  let end = wall.a[axis];
  let length = 0;
  for (const [lo, hi] of spans) {
    length += Math.max(0, hi - Math.max(lo, end));
    end = Math.max(hi, end);
  }
  return length;
}

/** 按所有顶点的坐标切格，精确计算横平竖直多边形的交并比。 */
function iou(a: Vec2[], b: Vec2[]) {
  const points = [...a, ...b];
  const xs = [...new Set(points.map(p => p[0]))].sort((x, y) => x - y);
  const ys = [...new Set(points.map(p => p[1]))].sort((x, y) => x - y);
  let intersection = 0;
  let union = 0;
  for (let i = 1; i < xs.length; i++) for (let j = 1; j < ys.length; j++) {
    const p: Vec2 = [(xs[i] + xs[i - 1]) / 2, (ys[j] + ys[j - 1]) / 2];
    const inA = pointInPolygon(p, a);
    const inB = pointInPolygon(p, b);
    const area = (xs[i] - xs[i - 1]) * (ys[j] - ys[j - 1]);
    if (inA || inB) union += area;
    if (inA && inB) intersection += area;
  }
  return intersection / union;
}

it.each([40, 80])("示例户型，%i 像素/米", scale => {
  // 示例含负的纵坐标。以 (60, 70) 映射平面坐标，再整体下移，为最上方的墙和尺寸标注留出空间。
  const shift = Math.max(0, Math.ceil(1.45 * scale + 30 - 70));
  const move = ([x, y]: Vec2): Vec2 => [x, y + shift / scale];
  const plan: House = {
    ...house,
    walls: house.walls.map(s => ({ ...s, a: move(s.a), b: move(s.b) })),
    rooms: house.rooms.map(r => ({ ...r, polygon: r.polygon.map(move) })),
    furniture: house.furniture.map(f => ({ ...f, pos: move(f.pos) })),
  };
  const { img, pixel, expected } = draw(plan, scale, scale === 80 ? 900 : 500, scale === 80 ? 1150 : 590, true);
  const start = performance.now();
  const result = detectPlan(img);
  const ms = performance.now() - start;
  const truth = plan.walls.map(w => ({ ...w, a: pixel(w.a), b: pixel(w.b), t: w.thickness * scale }));
  const solidHits = truth.filter(w => {
    const solid = wallFrame(w).len - w.openings.reduce((sum, o) => sum + o.width * scale, 0);
    return covered(w, result.walls) >= solid * 0.8;
  });
  const wallHits = truth.filter(w => covered(w, [...result.walls, ...result.gaps]) >= 0.8 * wallFrame(w).len);
  const extras = result.walls.filter(s => !truth.some(w => comparable(s, w) >= 0.5 * Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1])));
  const rooms = plan.rooms.filter(r => result.rooms.some(s => iou(r.polygon.map(pixel), s.polygon) >= 0.8));
  const gapMatches = expected.map(e => result.gaps.find(g =>
    Math.hypot((g.a[0] + g.b[0]) / 2 - e.point[0], (g.a[1] + g.b[1]) / 2 - e.point[1]) <= 0.3 * scale));
  const gapHits = gapMatches.filter(Boolean).length;
  const windows = expected.filter((e, i) => e.type === "window" && gapMatches[i]?.kind === "window").length;
  console.log(`${scale} px/m ${img.w}×${img.h}，墙厚 ${result.wallThickness}px，墙 ${result.walls.length} 墙轴命中 ${wallHits.length}/${truth.length} 实心命中 ${solidHits.length}/${truth.length} 误检 ${extras.length}，房间 ${result.rooms.length} 命中 ${rooms.length}/11，洞口 ${result.gaps.length} 命中 ${gapHits}/13，窗 ${windows}/4，${ms.toFixed(1)} ms`);
  expect(wallHits.length).toBeGreaterThanOrEqual(22);
  expect(solidHits.length).toBeGreaterThanOrEqual(18);
  for (const id of ["w10", "w11"]) expect(solidHits.map(w => w.id)).toContain(id);
  // 门边短墙从 JSON 的墙起点画到洞口 offset，按该小段单独检查实心覆盖。
  for (const id of ["w14", "w15"]) {
    const w = truth.find(w => w.id === id)!;
    const { d } = wallFrame(w);
    const length = w.openings[0].offset * scale;
    const b: Vec2 = [w.a[0] + d[0] * length, w.a[1] + d[1] * length];
    expect(covered({ ...w, b }, result.walls), id).toBeGreaterThanOrEqual(0.8 * length);
  }
  expect(extras.length).toBeLessThanOrEqual(2);
  expect(rooms.length).toBe(11);
  expect(gapHits).toBeGreaterThanOrEqual(11);
  expect(windows).toBeGreaterThanOrEqual(2);
  if (scale === 80) expect(ms).toBeLessThan(1500);
});

it("3×4 米单间，分别识别门和窗", () => {
  const polygon: Vec2[] = [[0, 0], [3, 0], [3, 4], [0, 4]];
  const walls: Wall[] = polygon.map((a, i) => ({
    id: String(i), a, b: polygon[(i + 1) % 4], thickness: 0.2, kind: "wall",
    openings: i === 0 ? [{ id: "d", type: "door", offset: 0.8, width: 0.9, bottom: 0, top: 2, hinge: "a", side: -1 }] :
      i === 2 ? [{ id: "w", type: "window", offset: 0.8, width: 1.2, bottom: 1, top: 2 }] : [],
  }));
  const { img } = draw({ ...house, walls, furniture: [], rooms: [] }, 50, 1200, 1500, false);
  const start = performance.now();
  const result = detectPlan(img);
  const ms = performance.now() - start;
  console.log(`单间 ${img.w}×${img.h}，墙 ${result.walls.length}，房间 ${result.rooms.length}，洞口 ${result.gaps.length}，${ms.toFixed(1)} ms`);
  expect(ms).toBeLessThan(1500);
  expect(result.walls).toHaveLength(6);
  expect(result.rooms).toHaveLength(1);
  expect(result.rooms[0].area).toBe(3 * 4 * 50 ** 2);
  expect(result.gaps.map(g => g.kind).sort()).toEqual(["door", "window"]);
});

function blankPlan(w = 430, h = 250) {
  const img: Gray = { w, h, data: new Uint8Array(w * h).fill(255) };
  const fill = (x: number, y: number, width: number, height: number) => {
    for (let row = y; row < y + height; row++) img.data.fill(20, row * w + x, row * w + x + width);
  };
  return { img, fill };
}

it("门洞直接靠墙角也能封住房间", () => {
  const { img, fill } = blankPlan();
  fill(24, 24, 12, 192);
  fill(384, 24, 12, 192);
  fill(24, 204, 372, 12);
  fill(75, 24, 321, 12);
  // 门扇贴着垂直墙，洞口另一侧才有同向的实墙。
  fill(36, 31, 1, 39);
  const { rooms, gaps } = detectPlan(img);
  expect(rooms).toHaveLength(1);
  expect(gaps).toContainEqual({ a: [30, 30], b: [75, 30], t: 12, kind: "door" });
});

it("超过二十倍墙厚的整排细线窗能连接外墙", () => {
  const { img, fill } = blankPlan();
  fill(24, 24, 12, 192);
  fill(384, 24, 12, 192);
  fill(24, 204, 372, 12);
  fill(24, 24, 29, 12);
  fill(368, 24, 28, 12);
  for (const y of [25, 29, 33]) fill(53, y, 315, 1);
  const { rooms, gaps } = detectPlan(img);
  expect(rooms).toHaveLength(1);
  expect(gaps.some(g => g.kind === "window" && g.b[0] - g.a[0] >= 310)).toBe(true);
});

it("房间里的孤立粗条不会成为墙", () => {
  const { img, fill } = blankPlan();
  fill(24, 24, 12, 192);
  fill(384, 24, 12, 192);
  fill(24, 24, 372, 12);
  fill(24, 204, 372, 12);
  fill(85, 90, 105, 12);
  const { walls, rooms } = detectPlan(img);
  expect(rooms).toHaveLength(1);
  expect(walls).toHaveLength(4);
});

it("两条细线中间留白时识别成空心墙", () => {
  const { img, fill } = blankPlan();
  fill(24, 24, 372, 12);
  fill(24, 204, 372, 12);
  for (const x of [24, 35, 204, 215, 384, 395]) fill(x, 36, 1, 168);
  const { walls, gaps, rooms } = detectPlan(img);
  expect(gaps).toHaveLength(0);
  expect(rooms).toHaveLength(2);
  expect(walls.some(w => w.a[0] === 210 && w.b[0] === 210 && w.t >= 10)).toBe(true);
});

const sample = "local/eval/synth-01.png";
it.skipIf(!existsSync(sample))("本地抗锯齿 PNG 的房间与墙轴", () => {
  const { walls, rooms, gaps, wallThickness } = detectPlan(pngGray(sample));
  const pixel = ([x, z]: Vec2): Vec2 => [110 + 70 * x, 211.5 + 70 * z];
  const segments = [...walls, ...gaps];
  const wallHits = house.walls.filter(w => {
    const axis = { ...w, a: pixel(w.a), b: pixel(w.b), t: w.thickness * 70 };
    return covered(axis, segments, 3) >= 0.8 * wallFrame(axis).len;
  });
  const roomMatches = house.rooms.map(room => {
    const polygon = room.polygon.map(pixel);
    const best = rooms.reduce((match, detected, i) => {
      const score = iou(polygon, detected.polygon);
      return score > match.score ? { index: i + 1, score } : match;
    }, { index: 0, score: 0 });
    return { name: room.name, ...best };
  });
  const roomHits = roomMatches.filter(r => r.score >= 0.7);
  for (const { name, index, score } of roomMatches) {
    const match = score >= 0.7 ? `检测房间 #${index}` : `未匹配，最佳检测房间 #${index || "无"}`;
    console.log(`${name} → ${match}，IoU ${score.toFixed(3)}`);
  }
  console.log(`${sample}，墙厚 ${wallThickness}px，墙 ${walls.length}，房间 ${rooms.length} 命中 ${roomHits.length}/11，墙轴命中 ${wallHits.length}/24，洞口 ${gaps.length}`);
  console.log(`墙轴覆盖不足 80%：${house.walls.filter(w => !wallHits.includes(w)).map(w => w.id).join("、") || "无"}`);
  expect(roomHits.length).toBeGreaterThanOrEqual(10);
  expect(roomHits.map(r => r.name)).toContain("阳台");
  expect(wallHits.length).toBeGreaterThanOrEqual(20);
});



