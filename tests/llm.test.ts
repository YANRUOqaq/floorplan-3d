import { describe, expect, it } from "vitest";
import example from "../examples/01-room.json";
import { parseHouse } from "../src/model/schema";
import { Store } from "../src/model/store";
import { budgetSummary } from "../src/model/budget";
import { applyOps, resolvePlace, type Op } from "../src/model/ops";
import { askAssistant } from "../src/llm/agent";
import { chat, extractJson, LlmError } from "../src/llm/client";
import { describeHouse } from "../src/llm/prompt";
import type { LlmSettings } from "../src/llm/providers";

const house = parseHouse(example);
const settings: LlmSettings = { provider: "deepseek", baseURL: "https://api.example.com/v1/", model: "m", visionModel: "", apiKey: "sk-test" };

/** 假的接口：按顺序返回给定的回复文字，并记下每次请求 */
function fakeFetch(replies: (string | { status: number; body: unknown })[]) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const r = replies.shift()!;
    if (typeof r === "string") return new Response(JSON.stringify({ choices: [{ message: { content: r } }] }), { status: 200 });
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("采购清单", () => {
  it("01 房示例：必买 17943、可选 2790，和原页面一致", () => {
    const b = budgetSummary(house);
    expect(b.required).toBe(17943);
    expect(b.optional).toBe(2790);
    expect(b.llm).toBe(0);
    expect(b.groups.find(g => g.room === "master")!.lines.map(l => l.id)).toContain("m2");   // 床垫这种清单项归到主卧
  });
  it("大模型估的价格单独合计", () => {
    const r = applyOps(house, [{ op: "addExtra", name: "床品四件套", price: 300 }]);
    expect(budgetSummary(r.house).llm).toBe(300);
    expect(budgetSummary(r.house).required).toBe(17943 + 300);
  });
});

describe("靠墙摆放", () => {
  it("床靠主卧北墙居中：背面贴墙内侧，正面朝南", () => {
    const { pos, rot } = resolvePlace(house, { room: "master", wall: "N", at: 0.5, gap: 0 }, [1.64, 2.08, 0.98]);
    expect(rot).toBe(0);
    expect(pos[1]).toBeCloseTo(5.85 + 0.06 + 1.04, 2);        // 北墙中线 + 半墙厚 + 半个床长
    expect(pos[0]).toBeCloseTo((6.46 + 0.82 + 9.15 - 0.82) / 2, 2);
  });
  it("靠东墙时朝西，at=0 在北端", () => {
    const { pos, rot } = resolvePlace(house, { room: "master", wall: "E", at: 0, gap: 0.1 }, [0.42, 0.42, 0.5]);
    expect(rot).toBe(-90);
    expect(pos[0]).toBeCloseTo(9.25 - 0.1 - 0.1 - 0.21, 2);
    expect(pos[1]).toBeCloseTo(5.85 + 0.06 + 0.21, 2);
  });
});

describe("修改指令", () => {
  it("增删改都能套用，说明逐条列出", () => {
    const ops: Op[] = [
      { op: "add", type: "plant", room: "guest", name: "龟背竹", pos: [6.9, 4.9], price: 120 },
      { op: "update", id: "l2", name: "白蜡木小圆茶几", price: 300 },
      { op: "remove", id: "m7" },
      { op: "setRoomFinish", room: "master", floorColor: "#B08A64" },
      { op: "setTheme", theme: "cream" },
    ];
    const r = applyOps(house, ops);
    expect(r.errors).toEqual([]);
    expect(r.lines.length).toBe(5);
    const h = r.house;
    expect(h.furniture.find(f => f.name === "龟背竹")?.priceBasis).toBe("llm");
    expect(h.furniture.find(f => f.id === "l2")?.price).toBe(300);
    expect(h.furniture.some(f => f.id === "m7")).toBe(false);
    expect(h.rooms.find(r => r.id === "master")?.floorColor).toBe("#B08A64");
    expect(h.theme).toBe("cream");
    expect(house.theme).toBe("natural");   // 原方案不受影响
  });
  it("原有设施不能动，找不到的 id 跳过并说明", () => {
    const r = applyOps(house, [{ op: "remove", id: "fx-toilet" }, { op: "move", id: "nope", pos: [1, 1] }]);
    expect(r.house.furniture.some(f => f.id === "fx-toilet")).toBe(true);
    expect(r.errors.length).toBe(2);
    expect(r.errors[0]).toMatch(/原有的设施/);
  });
  it("摆放问题：重叠、超出房间、挡门都会提示", () => {
    const r = applyOps(house, [
      { op: "add", type: "bed", room: "master", name: "床2", pos: [8.09, 8.0] },          // 和原来的床重叠
      { op: "add", type: "wardrobe", room: "master", name: "衣柜", pos: [9.3, 8] },        // 穿出东墙
      { op: "add", type: "cabinet", room: "master", name: "柜子", pos: [6.85, 6.45] },     // 主卧门口
    ]);
    expect(r.warnings.some(w => /床2 和 .*重叠/.test(w))).toBe(true);
    expect(r.warnings.some(w => /衣柜 (超出|嵌进)/.test(w))).toBe(true);
    expect(r.warnings.some(w => /柜子 挡住了门口/.test(w))).toBe(true);
  });
  it("椅子推进桌子底下不算重叠", () => {
    expect(applyOps(house, [{ op: "move", id: "l4-c1", pos: [2.05, 4.62] }]).warnings).toEqual([]);
  });
  it("应用后可以撤销", () => {
    const s = new Store(house);
    s.replace(applyOps(house, [{ op: "setTheme", theme: "walnut" }]).house, "大模型修改");
    expect(s.house.theme).toBe("walnut");
    s.undo(); expect(s.house.theme).toBe("natural");
  });
});

describe("对话流程（模拟接口）", () => {
  const ok = JSON.stringify({ reply: "加了一盆绿植。", ops: [{ op: "add", type: "plant", room: "guest", name: "龟背竹", place: { wall: "S", at: 0.1 } }] });

  it("请求带上 Key、JSON 模式和家具目录；回复套用成预览", async () => {
    const f = fakeFetch([ok]);
    const r = await askAssistant(settings, house, [], "加点绿植", { fetchFn: f.fn });
    expect(f.calls[0].url).toBe("https://api.example.com/v1/chat/completions");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(f.calls[0].body.response_format).toEqual({ type: "json_object" });
    expect(f.calls[0].body.messages[0].content).toContain("sofa_l");
    expect(f.calls[0].body.messages.at(-1).content).toContain("加点绿植");
    expect(r.repaired).toBe(false);
    expect(r.preview?.lines[0]).toMatch(/龟背竹/);
  });
  it("第一次格式不对：把错误发回去，第二次对了就用第二次", async () => {
    const f = fakeFetch(['{"reply": "好", "ops": [{"op": "add", "type": "spaceship"}]}', "```json\n" + ok + "\n```"]);
    const r = await askAssistant(settings, house, [], "加点绿植", { fetchFn: f.fn });
    expect(r.repaired).toBe(true);
    expect(f.calls.length).toBe(2);
    expect(f.calls[1].body.messages.at(-1).content).toMatch(/不符合要求的格式/);
    expect(r.preview?.house.furniture.some(x => x.name === "龟背竹")).toBe(true);
  });
  it("两次都不对就报错，不再重试", async () => {
    const f = fakeFetch(["不是 JSON", "还不是"]);
    await expect(askAssistant(settings, house, [], "x", { fetchFn: f.fn })).rejects.toThrow(LlmError);
    expect(f.calls.length).toBe(2);
  });
  it("只是提问时 ops 为空，没有预览", async () => {
    const f = fakeFetch(['{"reply": "主卧净宽约 2.65 m。", "ops": []}']);
    expect((await askAssistant(settings, house, [], "主卧多宽", { fetchFn: f.fn })).preview).toBeNull();
  });
  it("Key 不对时给出看得懂的错误", async () => {
    const f = fakeFetch([{ status: 401, body: { error: { message: "invalid api key" } } }]);
    await expect(chat(settings, [{ role: "user", content: "hi" }], { fetchFn: f.fn })).rejects.toThrow(/Key 不对.*invalid api key/);
  });
  it("没填 Key 不发请求", async () => {
    const f = fakeFetch([]);
    await expect(chat({ ...settings, apiKey: "" }, [], { fetchFn: f.fn })).rejects.toThrow(/API Key/);
    expect(f.calls.length).toBe(0);
  });
  it("从带说明文字的回复里取出 JSON", () => {
    expect(extractJson('好的：{"reply":"a","ops":[]} 以上')).toEqual({ reply: "a", ops: [] });
  });
  it("发给大模型的方案描述包含门窗朝向，不包含底图", () => {
    const d = describeHouse(house);
    const master = d.rooms.find(r => r.id === "master")!;
    expect(master.doors.some(x => x.side === "W")).toBe(true);
    expect(master.windows.some(x => x.side === "S")).toBe(true);
    expect(JSON.stringify(d)).not.toContain("background");
  });
});
