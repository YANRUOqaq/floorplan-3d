import { describe, expect, it } from "vitest";
import { applyDraft, draftFromRecognition, recognize, type Recognition } from "../src/llm/recognize";
import { parseHouse } from "../src/model/schema";
import { LlmError } from "../src/llm/client";

// 比例：横向 24 像素/米、纵向 25 像素/米（照片被拉伸），原图 (100, 200) 是世界原点；发送的图从原图 (100, 200) 开始、缩小一半
const map = { offset: [100, 200] as [number, number], scale: 2, bg: { pxPerM: 24, pxPerMz: 25, origin: [100, 200] as [number, number] } };
// 发送图里一个 4 m × 3 m 的房间：x 方向 4 m = 96 原图像素 = 48 发送图像素；z 方向 3 m = 75 原图像素 = 37.5 发送图像素
const rec: Recognition = {
  walls: [
    { a: [0, 0], b: [48, 0.6], thickness: 2.4 },          // 有点歪，应拉平
    { a: [48.5, 0], b: [48, 37.5] },                        // 端点和上一面墙差 0.5 像素 = 2 cm，应合并
    { a: [48, 37.5], b: [0, 37.5] },
    { a: [0, 37.5], b: [0, 0] },
    { a: [10, 10], b: [10.5, 11] },                          // 太短，丢掉
  ],
  openings: [
    { type: "door", a: [20, 37.5], b: [29, 37.5] },          // 南墙上的门，宽 9 像素 = 0.75 m
    { type: "window", a: [20, 80], b: [30, 80] },            // 离墙太远，丢掉
  ],
  rooms: [{ name: "主卧", polygon: [[0, 0], [48, 0], [48, 37.5], [0, 37.5]] }],
};

describe("户型图识别结果整理", () => {
  const d = draftFromRecognition(rec, map, 2.75);
  it("像素按横竖两个比例换算成米", () => {
    // 歪墙拉正、端点取平均后会有 1~2 cm 的偏差，草稿允许
    expect(d.walls[2].a[0]).toBeCloseTo(4, 1); expect(d.walls[2].a[1]).toBeCloseTo(3, 2);
    expect(d.rooms[0].polygon[2]).toEqual([4, 3]);
  });
  it("接近水平的墙拉平，相近端点合并，太短的丢掉", () => {
    expect(d.walls.length).toBe(4);
    expect(d.walls[0].a[1]).toBe(d.walls[0].b[1]);
    expect(d.walls[0].b).toEqual(d.walls[1].a);
    expect(d.walls[0].thickness).toBe(0.2);   // 2.4 × 2 / 24 = 0.2 m
  });
  it("门挂到最近的墙上，离墙太远的窗丢掉", () => {
    const south = d.walls[2];
    expect(south.openings.length).toBe(1);
    expect(south.openings[0].width).toBeCloseTo(0.75, 2);
    expect(south.openings[0].type).toBe("door");
    expect(d.dropped).toBe(2);
  });
  it("按名字猜房间类型，套上默认地面墙面", () => {
    expect(d.rooms[0].type).toBe("bedroom");
    expect(d.rooms[0].floor).toBe("wood");
  });
  it("替换墙和房间后仍是合格的方案；和家具重名的 id 加后缀", () => {
    const h = parseHouse({ version: 1, name: "t", walls: [], rooms: [], furniture: [{ id: "w1", type: "bed", pos: [2, 1.5], size: [1.5, 2, 0.9] }] });
    const out = parseHouse(applyDraft(h, d));
    expect(out.walls[0].id).toBe("w1_2");
    expect(out.furniture.length).toBe(1);
  });
});

describe("识图请求", () => {
  it("没填识图模型时直接提示，不发请求", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    await expect(recognize({ provider: "x", baseURL: "https://a", model: "m", visionModel: "", apiKey: "k" }, "data:", 10, 10, { fetchFn: f })).rejects.toThrow(LlmError);
    expect(called).toBe(false);
  });
  it("图片按 image_url 发送，用识图模型", async () => {
    let body: any;
    const f = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rec) } }] })); }) as unknown as typeof fetch;
    const r = await recognize({ provider: "x", baseURL: "https://a", model: "m", visionModel: "vl", apiKey: "k" }, "data:image/jpeg;base64,AAA", 48, 38, { fetchFn: f });
    expect(body.model).toBe("vl");
    expect(body.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } });
    expect(r.walls.length).toBe(5);
  });
});
