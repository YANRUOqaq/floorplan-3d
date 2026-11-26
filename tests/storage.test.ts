import { describe, expect, it } from "vitest";
import { clearKey, findSettings, loadSettings, saveSettings } from "../src/llm/providers";
import { Store } from "../src/model/store";
import { emptyHouse } from "../src/model/schema";

/** 内存里的 localStorage */
function mem(init?: unknown) {
  const m = new Map<string, string>();
  if (init !== undefined) m.set("floorplan-3d:llm", JSON.stringify(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe("大模型设置：每家厂商的 Key 分开存", () => {
  it("切换厂商时不会把上一家的 Key 带过去，切回来还在", () => {
    const st = mem();
    saveSettings({ ...loadSettings(st, "deepseek"), apiKey: "ds-key" }, st);
    const qwen = loadSettings(st, "qwen");
    expect(qwen.apiKey).toBe("");
    expect(qwen.baseURL).toContain("dashscope");
    saveSettings({ ...qwen, apiKey: "qw-key" }, st);
    expect(loadSettings(st).provider).toBe("qwen");
    expect(loadSettings(st, "deepseek").apiKey).toBe("ds-key");
  });
  it("旧格式（只存一家）读进来不用重填 Key", () => {
    const st = mem({ provider: "qwen", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", visionModel: "", apiKey: "k" });
    const s = loadSettings(st);
    expect(s).toMatchObject({ provider: "qwen", apiKey: "k", model: "qwen-plus", imageModel: "qwen-image-2.1-pro" });
  });
  it("对话用 DeepSeek 时，识图和精修自动用填过 Key 的千问", () => {
    const st = mem();
    saveSettings({ ...loadSettings(st, "qwen"), apiKey: "qw-key" }, st);
    saveSettings({ ...loadSettings(st, "deepseek"), apiKey: "ds-key" }, st);
    expect(loadSettings(st).provider).toBe("deepseek");
    expect(findSettings(s => !!s.visionModel, st)?.provider).toBe("qwen");
    expect(findSettings(s => !!s.imageModel, st)?.apiKey).toBe("qw-key");
  });
  it("清除 Key 清掉所有厂商的", () => {
    const st = mem();
    saveSettings({ ...loadSettings(st, "qwen"), apiKey: "a" }, st);
    saveSettings({ ...loadSettings(st, "deepseek"), apiKey: "b" }, st);
    clearKey(st);
    expect(loadSettings(st, "qwen").apiKey).toBe("");
    expect(loadSettings(st, "deepseek").apiKey).toBe("");
    expect(findSettings(() => true, st)).toBeNull();
  });
});

describe("上一个方案", () => {
  it("存进去能读回来；没存过、存坏了都返回 null", () => {
    const m = new Map<string, string>(), st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    expect(Store.loadPrevious(st)).toBeNull();
    Store.savePrevious(st, emptyHouse("我家"));
    expect(Store.loadPrevious(st)?.name).toBe("我家");
    m.set("floorplan-3d:previous", "{坏了");
    expect(Store.loadPrevious(st)).toBeNull();
    // 和自动保存位分开，不会互相覆盖
    expect(Store.restore(st)).toBeNull();
  });
});
