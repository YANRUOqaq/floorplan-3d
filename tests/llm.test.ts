import { describe, expect, it } from "vitest";
import example from "../examples/01-room.json";
import { formatIssues, parseHouse } from "../src/model/schema";
import { Store } from "../src/model/store";
import { budgetSummary } from "../src/model/budget";
import { applyOps, LlmReply, refProblems, resolvePlace, type Op } from "../src/model/ops";
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

describe("挨着别的家具、放在别的家具上", () => {
  // 主卧清空后重新布置，免得和原来的床重叠
  const empty = parseHouse({ ...example, furniture: example.furniture.filter(f => f.room !== "master") });
  const bedroom: Op[] = [
    { op: "add", type: "bed", room: "master", ref: "bed", name: "床", size: [1.54, 2.08, 0.98], place: { wall: "E", at: 0.5, gap: 0 } },
    { op: "add", type: "nightstand", room: "master", ref: "ns1", name: "床头柜北", place: { beside: "bed", side: "N", gap: 0 } },
    { op: "add", type: "nightstand", room: "master", name: "床头柜南", place: { beside: "bed", side: "S", gap: 0 } },
    { op: "add", type: "table_lamp", room: "master", name: "台灯", place: { on: "ns1" } },
  ];
  const r = applyOps(empty, bedroom);
  const get = (n: string) => r.house.furniture.find(f => f.name === n)!;

  it("床头柜贴着床的两侧，背面和床头对齐，朝向和床一样", () => {
    const bed = get("床"), n = get("床头柜北"), s = get("床头柜南");
    expect(bed.rot).toBe(-90);                                  // 靠东墙，朝西
    expect(n.rot).toBe(-90);
    expect(n.pos[0]).toBeCloseTo(bed.pos[0] + 1.04 - 0.21, 2);   // 背面都贴着东墙
    expect(n.pos[1]).toBeCloseTo(bed.pos[1] - 0.77 - 0.21, 2);  // 在床的北边，紧挨着
    expect(s.pos[1]).toBeCloseTo(bed.pos[1] + 0.77 + 0.21, 2);
  });
  it("台灯放在床头柜上：位置相同，离地高度是床头柜的高度", () => {
    const n = get("床头柜北"), lamp = get("台灯");
    expect(lamp.pos).toEqual(n.pos);
    expect(lamp.elevation).toBeCloseTo(n.size[2], 3);
  });
  it("这样摆没有重叠、没有挡门；说明里写清挨着谁、放在谁上", () => {
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.lines[1]).toMatch(/挨着床/);
    expect(r.lines[3]).toMatch(/放在床头柜北上/);
  });
  it("椅子放在书桌前面时转过来面朝书桌", () => {
    const desk = house.furniture.find(f => f.type === "desk")!;
    const c = applyOps(house, [{ op: "add", type: "chair", room: desk.room!, name: "椅子", place: { beside: desk.id, side: ({ 0: "S", 90: "E", 180: "N", [-90]: "W" } as const)[desk.rot as 0 | 90 | 180 | -90], gap: 0 } }]);
    const chair = c.house.furniture.find(f => f.name === "椅子")!;
    expect(Math.abs(((chair.rot - desk.rot) % 360 + 360) % 360)).toBe(180);
  });
  it("放到家具背面、引用不存在的家具：跳过并说明", () => {
    const x = applyOps(empty, [
      bedroom[0],
      { op: "add", type: "nightstand", room: "master", name: "柜", place: { beside: "bed", side: "E", gap: 0 } },   // 床靠东墙，东边是床头
      { op: "add", type: "table_lamp", room: "master", name: "灯", place: { on: "nope" } },
    ]);
    expect(x.errors.length).toBe(2);
    expect(x.errors[0]).toMatch(/背面/);
    expect(x.errors[1]).toMatch(/找不到 nope/);
  });
  it("引用写成 \"ref:bed1\" 也认", () => {
    const x = applyOps(empty, [bedroom[0], { op: "add", type: "nightstand", room: "master", name: "柜", place: { beside: "ref:bed", side: "N", gap: 0 } }]);
    expect(x.errors).toEqual([]);
  });
  it("没写 ref 的新家具按“类型+序号”自动有名字：第二个床头柜是 nightstand2", () => {
    const ops: Op[] = [
      { op: "add", type: "bed", room: "master", name: "床", place: { wall: "E", at: 0.5, gap: 0 } },
      { op: "add", type: "nightstand", room: "master", name: "柜北", place: { beside: "bed1", side: "N", gap: 0 } },
      { op: "add", type: "nightstand", room: "master", name: "柜南", place: { beside: "bed1", side: "S", gap: 0 } },
      { op: "add", type: "table_lamp", room: "master", name: "灯", place: { on: "nightstand2" } },
    ];
    expect(refProblems(empty, ops)).toEqual([]);
    const x = applyOps(empty, ops);
    expect(x.errors).toEqual([]);
    expect(x.house.furniture.find(f => f.name === "灯")!.pos).toEqual(x.house.furniture.find(f => f.name === "柜南")!.pos);
  });
  it("找不到的名字、和已有 id 撞名分不清的，都报出来，不猜", () => {
    expect(refProblems(house, [{ op: "move", id: "l1", place: { beside: "sofa9", side: "N", gap: 0 } }])).toEqual(["第 1 条指令：找不到 sofa9"]);
    expect(refProblems(house, [{ op: "move", id: "l1", place: { beside: "l2", side: "N", gap: 0 } }])).toEqual([]);   // 已有家具的 id
    // 2D 编辑器画的床 id 也叫 bed1：这时新加一张床再说 bed1 就分不清
    const drawn = parseHouse({ ...example, furniture: [...example.furniture.filter(f => f.room !== "master"), { id: "bed1", type: "bed", room: "master", pos: [8, 8], size: [1.5, 2, 0.9] }] });
    const p = refProblems(drawn, [bedroom[0], { op: "add", type: "table_lamp", room: "master", name: "灯", place: { on: "bed1" } }]);
    expect(p[0]).toMatch(/分不清/);
  });
  it("move 靠墙时不写 room 就留在原来的房间（2026-11-24 实测大模型这样写）", async () => {
    const s1 = house.furniture.find(f => f.id === "s1")!;
    const f = fakeFetch([JSON.stringify({ reply: "好", ops: [{ op: "move", id: "s1", place: { wall: "W", at: 0.5, gap: 0 } }] })]);
    const r = await askAssistant(settings, house, [], "折叠床挪到西墙", { fetchFn: f.fn });
    expect(r.repaired).toBe(false);
    const moved = r.preview!.house.furniture.find(x => x.id === "s1")!;
    expect(moved.room).toBe(s1.room);
    expect(moved.rot).toBe(90);
  });
  it("move 也能挨着别的家具放", () => {
    const m = applyOps(r.house, [{ op: "move", id: get("床头柜南").id, place: { beside: get("床").id, side: "N", gap: 0.5 } }]);
    const moved = m.house.furniture.find(f => f.name === "床头柜南")!;
    expect(moved.pos[1]).toBeCloseTo(get("床").pos[1] - 0.77 - 0.5 - 0.21, 2);
  });
});

describe("修改说明只写真正变了的", () => {
  it("价格写出原价和新价；原样再写一遍的字段算没改，整条跳过", () => {
    const l2 = house.furniture.find(f => f.id === "l2")!;
    const r = applyOps(house, [{ op: "update", id: "l2", price: l2.price! + 100 }, { op: "update", id: "l1", name: house.furniture.find(f => f.id === "l1")!.name }]);
    expect(r.lines).toEqual([`改 ${l2.name}：价格 ¥${l2.price} → 约 ¥${l2.price! + 100}`]);
    expect(r.errors[0]).toMatch(/没有要改的地方/);
  });
  it("风格用中文名；和现在一样的风格跳过", () => {
    expect(applyOps(house, [{ op: "setTheme", theme: "cream" }]).lines).toEqual(["整体风格换成奶油风"]);
    expect(applyOps(house, [{ op: "setTheme", theme: "natural" }]).errors[0]).toMatch(/本来就是原木日式/);
  });
  it("房间颜色：写出颜色值；给 null 回到跟随风格；瓷砖地面的地板颜色跳过", () => {
    const a = applyOps(house, [{ op: "setRoomFinish", room: "master", floorColor: "#B08A64", wall: "paint" }]);
    expect(a.lines).toEqual(["主卧：地板颜色 #B08A64"]);            // wall 本来就是 paint，不算改动
    const b = applyOps(a.house, [{ op: "setRoomFinish", room: "master", floorColor: null }]);
    expect(b.house.rooms.find(r => r.id === "master")!.floorColor).toBeUndefined();
    expect(b.lines).toEqual(["主卧：地板颜色跟随整体风格"]);
    const c = applyOps(house, [{ op: "setRoomFinish", room: "kitchen", floorColor: "#FFFFFF" }]);
    expect(c.lines).toEqual([]);
    expect(c.errors[0]).toMatch(/不是木地板/);
  });
  it("update 也能改清单项的价格", () => {
    const m2 = house.extras.find(x => x.id === "m2")!;
    const r = applyOps(house, [{ op: "update", id: "m2", price: m2.price + 100 }]);
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([`改清单项 ${m2.name}：价格 ¥${m2.price} → 约 ¥${m2.price + 100}`]);
    expect(r.house.extras.find(x => x.id === "m2")!.priceBasis).toBe("llm");
  });
  it("清单里已有同类的项时提醒可能重复：去掉房间名、括号说明、尺寸再比", () => {
    // 2026-11-24 实测：示例主卧已有“床垫”，大模型又加了“主卧床垫（1.5m）”
    const r = applyOps(house, [{ op: "addExtra", name: "主卧1.5m床垫（独立袋装弹簧）", price: 1200, room: "master" }]);
    expect(r.warnings).toEqual(["清单里已经有“床垫”，和“主卧1.5m床垫（独立袋装弹簧）”可能重复了"]);
    expect(applyOps(house, [{ op: "addExtra", name: "主卧抱枕×2", price: 160, room: "master" }]).warnings).toEqual([]);
  });
  it("先加新的、再删旧的（替换）不算重复", () => {
    const r = applyOps(house, [{ op: "addExtra", name: "床垫（升级款）", price: 1500, room: "master" }, { op: "removeExtra", id: "m2" }]);
    expect(r.warnings).toEqual([]);
  });
});

describe("挡窗", () => {
  const empty = parseHouse({ ...example, furniture: example.furniture.filter(f => f.room !== "master") });
  it("床头顶在主卧南墙的窗下（床头高过窗台）要提醒；矮的床头柜不提醒", () => {
    // 主卧南墙有窗：窗台 0.6 m；床高 0.98 m，床头柜高 0.5 m
    const r = applyOps(empty, [
      { op: "add", type: "bed", room: "master", name: "床", place: { wall: "S", at: 0.5, gap: 0 } },
      { op: "add", type: "nightstand", room: "master", name: "柜", place: { beside: "bed1", side: "W", gap: 0 } },
    ]);
    expect(r.warnings).toEqual(["床 挡住了窗"]);
  });
  it("窗帘挂在窗前不算挡窗", () => {
    const r = applyOps(empty, [{ op: "add", type: "curtain", room: "master", name: "窗帘", place: { wall: "S", at: 0.5, gap: 0 } }]);
    expect(r.warnings.filter(w => w.includes("挡住了窗"))).toEqual([]);
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
  it("引用了不存在的家具：把找不到的名字发回去，让它改", async () => {
    const bad = JSON.stringify({ reply: "好", ops: [
      { op: "add", type: "bed", room: "master", name: "床", place: { wall: "E", at: 0.5 } },
      { op: "add", type: "table_lamp", room: "master", name: "灯", place: { on: "bigbed" } },
    ] });
    const good = JSON.stringify({ reply: "好", ops: [
      { op: "add", type: "bed", room: "master", ref: "bigbed", name: "床", place: { wall: "E", at: 0.5 } },
      { op: "add", type: "table_lamp", room: "master", name: "灯", place: { on: "bigbed" } },
    ] });
    const f = fakeFetch([bad, good]);
    const r = await askAssistant(settings, house, [], "布置主卧", { fetchFn: f.fn });
    expect(f.calls[1].body.messages.at(-1).content).toMatch(/找不到 bigbed[\s\S]*类型\+序号/);
    expect(r.repaired).toBe(true);
    expect(r.preview?.errors).toEqual([]);
  });
  it("坐标写进了 place（{\"place\":{\"pos\":…}}）时直接按 pos 处理，不用重试", async () => {
    const f = fakeFetch([JSON.stringify({ reply: "好", ops: [{ op: "add", type: "rug", room: "master", name: "地毯", place: { pos: [7.8, 8.5], rot: 90 } }] })]);
    const r = await askAssistant(settings, house, [], "加块地毯", { fetchFn: f.fn });
    expect(r.repaired).toBe(false);
    const rug = r.preview!.house.furniture.find(x => x.name === "地毯")!;
    expect(rug.pos).toEqual([7.8, 8.5]);
    expect(rug.rot).toBe(90);
  });
  it("place 写错时，发回去的错误说清三种正确写法", () => {
    const r = LlmReply.safeParse({ reply: "", ops: [{ op: "move", id: "l1", place: { foo: 1 } }] });
    expect(r.success).toBe(false);
    expect(formatIssues(r.error!)).toMatch(/place 只能是这三种之一/);
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
  it("没标价的家具写成 price: null（原有设施不写）；房间单独设的颜色也写上", () => {
    const h = applyOps(house, [{ op: "setRoomFinish", room: "master", floorColor: "#B08A64" }]).house;
    const d = describeHouse(h);
    const tv = d.furniture.find(f => f.id === "o1")!, toilet = d.furniture.find(f => f.id === "fx-toilet")!;
    expect((tv as { price?: unknown }).price).toBeNull();
    expect("price" in toilet).toBe(false);
    expect(d.rooms.find(r => r.id === "master")!.floorColor).toBe("#B08A64");
  });
});
