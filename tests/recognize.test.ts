import { describe, expect, it } from "vitest";
import example from "../examples/01-room.json";
import { parseHouse, type Vec2 } from "../src/model/schema";
import { axesOf, checkChains, matchAxes, rectify, snapCoords, unionPolygon, wallsFromRooms, type Chain } from "../src/model/draft";
import { estimateScale, outerSpan, scaleFromAreas } from "../src/model/scale";
import { fuse, markAnchor, overlapRatio, type VlmOpening, type VlmRoom } from "../src/model/fuse";
import type { Detection, PxGap, PxWall } from "../src/model/raster";
import { draftFromReading, markId, readPlan, type SentImage } from "../src/llm/recognize";
import { scorePlan } from "../src/model/evaluate";
import { polygonArea, wallFrame, wallPoint } from "../src/model/geometry";
import { LlmError } from "../src/llm/client";

const truth = parseHouse(example);

// 示例那一户画在图上：每米 30 像素，原点在 (100, 80)
const K = 30, O: Vec2 = [100, 80];
const px = (p: Vec2): [number, number] => [O[0] + p[0] * K, O[1] + p[1] * K];
let seed = 7;
/** 固定的“随机”抖动，模拟误差 */
const jitter = (a: number) => { seed = (seed * 9301 + 49297) % 233280; return (seed / 233280 - 0.5) * 2 * a; };

/** 理想的像素检测结果：示例的墙按门窗切成段（洞口单独列出），房间多边形照搬 */
function idealDetection(): Detection {
  const walls: PxWall[] = [], gaps: PxGap[] = [];
  for (const w of truth.walls) {
    const { len } = wallFrame(w), t = w.thickness * K;
    let cur = 0;
    const seg = (u0: number, u1: number) => { if (u1 - u0 > 0.05) walls.push({ a: px(wallPoint(w, u0)), b: px(wallPoint(w, u1)), t }); };
    for (const o of [...w.openings].sort((p, q) => p.offset - q.offset)) {
      seg(cur, o.offset);
      gaps.push({ a: px(wallPoint(w, o.offset)), b: px(wallPoint(w, o.offset + o.width)), t, kind: o.type === "window" ? "window" : o.type === "door" || o.type === "entry" ? "door" : "open" });
      cur = o.offset + o.width;
    }
    seg(cur, len);
  }
  return { walls, gaps, rooms: truth.rooms.map(r => ({ polygon: r.polygon.map(px), area: polygonArea(r.polygon) * K * K })), wallThickness: 0.2 * K };
}
// 尺寸链：图下方 0、3.75、6.4、7.5、9.25（3750 2650 1100 1750），左侧 0、3.25、5.85、10.15
const H: Chain = { dir: "h", mm: [3750, 2650, 1100, 1750] };
const V: Chain = { dir: "v", mm: [3250, 2600, 4300] };
/** 模型认出的房间：名字对，位置差 ±0.6 m */
const vlmRooms: VlmRoom[] = truth.rooms.map(r => ({ name: r.name, type: r.type, polygon: r.polygon.map(p => px([p[0] + jitter(0.6), p[1] + jitter(0.6)])) }));
const vlmOpenings: VlmOpening[] = truth.walls.flatMap(w => w.openings.map(o => ({ type: o.type, at: px(wallPoint(w, o.offset + o.width / 2)) })));

describe("尺寸链", () => {
  it("检查：编出来的一整排、读不出的、重复的不用；分段之和等于总长的标成核对过", () => {
    const r = checkChains([H, H, { dir: "h", mm: [9250] }, { dir: "h", mm: [2200, 2200, 2200, 2200] }, { dir: "v", mm: [3250, null] }, V]);
    expect(r.usable.map(c => c.mm.join(" "))).toEqual(["3750 2650 1100 1750", "3250 2600 4300"]);
    expect(r.usable[0].ok).toBe(true);
    expect(r.problems.some(p => p.includes("同一个数"))).toBe(true);
    expect(r.problems.some(p => p.includes("读不出"))).toBe(true);
  });
  it("总长只和其中连续几段的和对得上也算核对过（整栋楼的图常这样标）", () => {
    expect(checkChains([{ dir: "h", mm: [1700, 3750, 3750, 1700] }, { dir: "h", mm: [7500] }]).usable[0].ok).toBe(true);
  });
  it("和墙对上求比例：不需要数字的位置，墙中线有一两像素误差也准", () => {
    const lines = [0, 1.6, 3.75, 5.15, 6.4, 7.5, 8.1, 9.25].map(x => O[0] + x * K + jitter(1.5));
    const m = matchAxes(axesOf(H), lines)!;
    expect(m.matched).toBe(5);
    expect(m.s).toBeCloseTo(K, 0);
    expect(Math.abs(m.o - O[0])).toBeLessThan(3);
  });
  it("读错一个数：前面的轴线照样对得上，比例还是准的", () => {
    // 墙只有五六面时，乱写的数字也可能碰巧对上三条，单条链排除不了，靠融合时横竖互相核对（见下面“数字全错”那条）
    const lines = [0, 3.75, 6.4, 7.5, 9.25].map(x => O[0] + x * K);
    expect(matchAxes(axesOf({ dir: "h", mm: [3750, 2650, 2100, 1750] }), lines)!.s).toBeCloseTo(K, 5);
  });
  it("整栋楼的长尺寸链：只数落在这一户范围内的轴线", () => {
    const lines = [0, 3.75, 6.4, 7.5, 9.25].map(x => O[0] + x * K);
    const m = matchAxes(axesOf({ dir: "h", mm: [1700, 2650, 1400, 3750, 2650, 1100, 1750, 1700, 2650] }), lines)!;
    expect(m.s).toBeCloseTo(K, 5);
    expect(m.matched).toBe(5);
  });
});

describe("比例：尺寸链、总尺寸、面积互相核对", () => {
  const det = idealDetection();
  const areaRooms = (k = 1) => det.rooms.map((r, i) => ({ polygon: r.polygon, area: Math.round(polygonArea(truth.rooms[i].polygon) / 1.15 * k * 100) / 100 }));
  it("尺寸链对墙中线", () => {
    const sc = estimateScale(det, [H, V], [], null);
    expect(sc.from).toBe("chains");
    expect(sc.sx).toBeCloseTo(K, 1); expect(sc.sz).toBeCloseTo(K, 1);
  });
  it("模型把竖着的链说成横的：两个方向都试，照样对上", () => {
    const sc = estimateScale(det, [H, { ...V, dir: "h" }], [], null);
    expect(sc.from).toBe("chains");
    expect(sc.sz).toBeCloseTo(K, 1);
  });
  it("一条链数字全错碰巧对上几面墙：和另一个方向的比例对不上，不用它", () => {
    const sc = estimateScale(det, [{ dir: "h", mm: [5750, 1650, 2100, 750] }, V, { dir: "v", mm: [10150] }], [], null);
    expect(sc.sx).toBeCloseTo(K, 1);
    expect(sc.problems.some(p => p.includes("5750") && p.includes("差了"))).toBe(true);
  });
  it("只有总尺寸（一个数）：对外墙跨度，横竖一致就用", () => {
    expect(outerSpan(det, "h").lines).toBeCloseTo(9.25 * K, 0);
    const sc = estimateScale(det, [{ dir: "h", mm: [9250] }, { dir: "v", mm: [13100] }], [], null);   // 示例竖向从生活阳台（-1.45）到阳台外沿（11.65）
    expect(sc.from).toBe("overall");
    expect(sc.sx).toBeCloseTo(K, 1); expect(sc.sz).toBeCloseTo(K, 1);
  });
  it("总尺寸换算出的墙厚不合常理（读错了数）就不用", () => {
    expect(() => estimateScale(det, [{ dir: "h", mm: [925] }], [], null)).toThrow(/标定比例/);
  });
  it("面积：至少三间、彼此一致才用", () => {
    expect(scaleFromAreas(areaRooms())!.s).toBeCloseTo(K, 0);
    const sc = estimateScale(det, [], areaRooms(), null);
    expect(sc.from).toBe("areas");
    expect(sc.sx).toBeCloseTo(K, -1);
  });
  it("编出来的面积（彼此对不上）不用，说明原因", () => {
    const fake = areaRooms().map((r, i) => ({ ...r, area: [22, 13, 12.6, 17.5, 15.5, 10.5, 4.2, 4.2, 10.5, 12.4, 10.5][i] }));
    expect(scaleFromAreas(fake)).toBeNull();
    expect(() => estimateScale(det, [], fake, null)).toThrow(/标定比例/);
  });
  it("尺寸链只对上一个方向、和图上印着的面积差 15% 以上：信面积（模型读错方向或读错数时会这样）", () => {
    const wrong = { dir: "h" as const, mm: H.mm.map(v => v! * 0.8) };
    const sc = estimateScale(det, [wrong], areaRooms(), null, true);
    expect(sc.from).toBe("areas");
    expect(sc.sx).toBeCloseTo(K, -1);
    expect(sc.problems.some(p => p.includes("按面积算的"))).toBe(true);
  });
  it("没确认是图上印着的面积（可能是模型估的）不能推翻尺寸链", () => {
    const wrong = { dir: "h" as const, mm: H.mm.map(v => v! * 0.8) };
    expect(estimateScale(det, [wrong], areaRooms(), null, false).from).toBe("chains");
  });
  it("什么都没有：报错让用户先标定；有手动标定就用手动的", () => {
    expect(() => estimateScale(det, [], [], null)).toThrow(/标定比例/);
    expect(estimateScale(det, [], [], { pxPerM: 40 }).from).toBe("manual");
  });
});

describe("融合：像素里的墙 + 尺寸数字 + 模型认的房间名", () => {
  const f = fuse(idealDetection(), estimateScale(idealDetection(), [H, V], [], null), vlmRooms, vlmOpenings);
  const s = scorePlan(f, truth);
  it("被门窗隔开的墙段合成一面墙，墙和门窗基本都对", () => {
    expect(s.walls.within10).toBeGreaterThanOrEqual(22);
    expect(s.walls.extra).toBe(0);
    expect(s.openings.found).toBeGreaterThanOrEqual(12);
    expect(s.openings.sameType).toBeGreaterThanOrEqual(11);
  });
  it("房间名字和类型从模型那里对号入座（模型的位置差半米也能配上）", () => {
    expect(s.rooms.found).toBe(11);
    expect(s.rooms.sameType).toBe(11);
    expect(f.rooms.map(r => r.name).sort()).toEqual(truth.rooms.map(r => r.name).sort());
  });
  it("重叠比例", () => {
    const sq = (x: number, s: number): Vec2[] => [[x, 0], [x + s, 0], [x + s, s], [x, s]];
    expect(overlapRatio(sq(0, 2), sq(1, 2))).toBeCloseTo(0.5, 1);
  });
});

describe("按编号认房间和门窗（Set-of-Mark）", () => {
  const det = idealDetection();
  const sc = estimateScale(det, [H, V], [], null);
  it("编号的位置：离墙放得下标记，从房间正中横着偏开（房间名写在那），不放墙角", () => {
    const sq: Vec2[] = [[0, 0], [100, 0], [100, 80], [0, 80]];
    const p = markAnchor(sq, 12);
    expect(p[0]).toBeGreaterThanOrEqual(12); expect(p[0]).toBeLessThanOrEqual(88);
    expect(p[1]).toBeGreaterThanOrEqual(12); expect(p[1]).toBeLessThanOrEqual(68);
    expect(Math.hypot(p[0] - 50, p[1] - 40)).toBeGreaterThan(20);
    expect(Math.abs(p[1] - 40)).toBeLessThan(5);   // 横着偏开，不往墙角跑
    // 太小放不下：取离墙最远的点
    const tiny: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const q = markAnchor(tiny, 12);
    expect(Math.abs(q[0] - 5)).toBeLessThan(1); expect(Math.abs(q[1] - 5)).toBeLessThan(1);
  });
  it("洞口字母：A~Z 之后是 AA、AB", () => {
    expect([0, 25, 26, 27].map(markId)).toEqual(["A", "Z", "AA", "AB"]);
  });
  it("名字按编号的位置落在哪个房间；门窗按字母的位置对上洞口（在像素分出的门、窗里细分），说不是门窗的当墙", () => {
    const named: VlmRoom[] = truth.rooms.map((r, i) => ({ name: r.name, type: r.type, at: markAnchor(det.rooms[i].polygon, 10) }));
    // 模型在像素分出的类里细分：说推拉门时，像素是窗、是门、看不出的都成推拉门；说“不是门窗”的当墙
    const opens: VlmOpening[] = det.gaps.map((g, i) => ({ type: i === 0 ? "none" : "sliding", at: [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2] }));
    const f = fuse(det, sc, named, opens, 2.75, ["储藏间"]);
    expect(f.rooms.map(r => r.name).sort()).toEqual(truth.rooms.map(r => r.name).sort());
    const all = f.walls.flatMap(w => w.openings);
    expect(all.length).toBe(det.gaps.length - 1);
    expect(all.every(o => o.type === "sliding")).toBe(true);
    expect(f.problems.some(p => p.includes("储藏间"))).toBe(true);
  });
  it("两个名字的编号落在同一个房间：提醒中间的墙可能没找到", () => {
    const r0 = det.rooms[0].polygon;
    const f = fuse(det, sc, [{ name: "客厅", at: markAnchor(r0, 5) }, { name: "餐厅", at: markAnchor(r0, 1) }], [], 2.75);
    expect(f.problems.some(p => p.includes("客厅、餐厅识别成了同一个房间"))).toBe(true);
  });
  it("按编号问模型：回答对回标记的位置；没标过的编号不要", async () => {
    const marks = { rooms: [{ id: "1", at: [10, 20] as Vec2 }, { id: "2", at: [30, 40] as Vec2 }], gaps: [{ id: "A", at: [50, 60] as Vec2 }] };
    const sent: string[] = [];
    const s = { provider: "qwen", baseURL: "https://x/v1", model: "m", visionModel: "vl", imageModel: "", apiKey: "k" };
    const f = (async (_u: string, init: RequestInit) => {
      const prompt = JSON.parse(init.body as string).messages[0].content[0].text as string;
      sent.push(prompt);
      const content = prompt.includes("尺寸标注链") ? { chains: [], areas: [25.7] }
        : { rooms: [{ id: 1, name: "客厅", type: "living", area: 25.7 }, { id: "2", name: "卧室" }, { id: 9, name: "编的" }], openings: [{ id: "a", type: "sliding" }], missing: ["储藏间"] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    }) as unknown as typeof fetch;
    const img: SentImage = { url: "data:", w: 100, h: 100, offset: [0, 0], scale: 1 };
    const r = await readPlan(s, img, img, { marks, fetchFn: f });
    expect(sent.some(p => p.includes("圆圈数字 1~2") && p.includes("A~A"))).toBe(true);
    expect(r.rooms).toEqual([{ name: "客厅", type: "living", at: [10, 20], area: 25.7 }, { name: "卧室", type: undefined, at: [30, 40] }]);
    expect(r.openings).toEqual([{ type: "sliding", at: [50, 60] }]);
    expect(r.missing).toEqual(["储藏间"]);
    expect(r.areaLabels).toEqual([25.7]);
  });
  it("模型报的面积：读尺寸那次没抄到（图上没印）的不用来算比例", () => {
    const rooms: VlmRoom[] = det.rooms.slice(0, 4).map((r, i) => ({ name: "房" + i, at: markAnchor(r.polygon, 5), area: 9 }));
    expect(() => draftFromReading({ chains: [], rooms, openings: [], areaLabels: [] }, det, null)).toThrow(/标定比例/);
  });
});

describe("房间整理（像素里找不到墙时的退路）", () => {
  it("大致横平竖直的多边形拉正", () => {
    const p = rectify([[0, 0], [4.02, 0.05], [3.97, 3.01], [0.03, 2.96]]);
    expect(p[0][1]).toBe(p[1][1]); expect(p[1][0]).toBe(p[2][0]); expect(p[2][1]).toBe(p[3][1]); expect(p[3][0]).toBe(p[0][0]);
  });
  it("L 形保留，三角形这种拉不正的用外接矩形", () => {
    expect(rectify([[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]).length).toBe(6);
    expect(rectify([[0, 0], [4, 0], [2, 3]]).length).toBe(4);
  });
  it("坐标吸附：近轴线的吸到轴线，其余相近的归成一条线", () => {
    const f = snapCoords([0.1, 3.6, 3.9, 5.1, 5.2], [0, 3.75]);
    expect([0.1, 3.6, 3.9].map(f)).toEqual([0, 3.75, 3.75]);
    expect(f(5.1)).toBe(f(5.2));
  });
  it("示例的房间生成的墙盖住示例的墙", () => {
    const walls = wallsFromRooms(truth.rooms, { xs: [0, 3.75, 6.4, 7.5, 9.25], zs: [0, 3.25, 5.85, 10.15] });
    const s = scorePlan({ walls, rooms: truth.rooms }, truth);
    expect(s.walls.within10).toBeGreaterThanOrEqual(21);
    expect(walls.some(w => w.kind === "railing")).toBe(true);
  });
  it("矩形并集", () => {
    expect(unionPolygon([[0, 2, 0, 2], [2, 4, 0, 1]]).length).toBe(6);
    expect(unionPolygon([[0, 2, 0, 2], [0, 2, 2, 4]]).length).toBe(4);
    expect(unionPolygon([[0, 1, 0, 1], [5, 9, 5, 9]])).toEqual([[5, 5], [9, 5], [9, 9], [5, 9]]);
  });
  it("没有像素检测结果：按模型的多边形和面积出草稿，并提醒误差大", () => {
    const sq = (x: number, y: number): Vec2[] => [[x, y], [x + 90, y], [x + 90, y + 120], [x, y + 120]];
    const d = draftFromReading({ chains: [], rooms: [0, 90, 180].map(x => ({ name: "卧室", polygon: sq(x, 0), area: 12 / 1.15 })), openings: [] }, null, null);
    expect(d.wallsFrom).toBe("model");
    expect(d.walls.length).toBeGreaterThanOrEqual(4);
    expect(d.problems[0]).toContain("没找到围成房间的实心墙线");
  });
  it("没有像素检测、没有面积、也没手动标定：报错让用户先标定", () => {
    expect(() => draftFromReading({ chains: [], rooms: [{ name: "卧室", polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] }], openings: [] }, null, null)).toThrow(/标定比例/);
  });
});

describe("调用识图模型（模拟接口）", () => {
  const img = (w: number, h: number, offset: Vec2 = [0, 0], scale = 1): SentImage => ({ url: "data:", w, h, offset, scale });
  const s = { provider: "qwen", baseURL: "https://x/v1", model: "m", visionModel: "vl", imageModel: "", apiKey: "k" };
  const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  it("两次调用同时发：整张图读尺寸数字，框出的一户认房间；相对坐标换成原图像素", async () => {
    const asked: string[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const prompt = JSON.parse(init.body as string).messages[0].content[0].text as string;
      asked.push(prompt.includes("尺寸标注链") ? "chains" : "rooms");
      return reply(prompt.includes("尺寸标注链") ? { chains: [{ dir: "h", mm: [3000, 3000], total: 6000 }] }
        : { rooms: [{ name: "卧室", polygon: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], area: 9 }], openings: [{ type: "door", at: [500, 1000], width: 100, rooms: ["卧室", "外面"] }] });
    }) as unknown as typeof fetch;
    // 整张图 1000×800 原样发；框出的一户是原图 (200, 100) 起、宽高 300 像素，放大成 600 发
    const r = await readPlan(s, img(1000, 800), img(600, 600, [200, 100], 0.5), { fetchFn: f });
    expect(asked.sort()).toEqual(["chains", "rooms"]);
    expect(r.chains).toEqual([{ dir: "h", mm: [3000, 3000], total: 6000 }]);
    expect(r.rooms[0].polygon![2]).toEqual([500, 400]);
    expect(r.openings[0].at).toEqual([350, 400]);
    expect(r.openings[0].widthPx).toBeCloseTo(30, 5);
  });
  it("模型把多边形摊平、点多给一个数、某一项缺字段：能读的照读，只丢读不了的那一项", async () => {
    const f = (async (_u: string, init: RequestInit) => {
      const prompt = JSON.parse(init.body as string).messages[0].content[0].text as string;
      return reply(prompt.includes("尺寸标注链") ? { chains: [{ dir: "h", mm: [3000] }, { dir: "斜", mm: [1] }] } : {
        rooms: [
          { name: "摊平", polygon: [0, 0, 100, 0, 100, 100, 0, 100] },
          { name: "包一层", polygon: [[0, 0, 100, 0, 100, 100]] },
          { name: "多一个数", polygon: [[0, 0, 0], [100, 0, 0], [100, 100, 0]] },
          { name: "点不够", polygon: [[0, 0], [1, 1]] },
          { polygon: [[0, 0], [1, 0], [1, 1]] },
        ],
        openings: [{ type: "door", at: [10, 20, 0] }, { type: "门", at: [1, 1] }],
      });
    }) as unknown as typeof fetch;
    const r = await readPlan(s, img(1000, 1000), img(1000, 1000), { fetchFn: f });
    expect(r.chains.map(c => c.mm)).toEqual([[3000]]);
    expect(r.rooms.map(x => x.name)).toEqual(["摊平", "包一层", "多一个数"]);
    expect(r.rooms[0].polygon).toEqual([[0, 0], [100, 0], [100, 100], [0, 100]]);
    expect(r.rooms[1].polygon).toEqual([[0, 0], [100, 0], [100, 100]]);
    expect(r.rooms[2].polygon).toEqual([[0, 0], [100, 0], [100, 100]]);
    expect(r.openings.map(o => o.at)).toEqual([[10, 20]]);
  });
  it("回复不是 JSON 时说清是哪一步", async () => {
    const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "看不清" } }] }))) as unknown as typeof fetch;
    await expect(readPlan(s, img(10, 10), img(10, 10), { fetchFn: f })).rejects.toThrow(LlmError);
  });
});
