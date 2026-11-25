import { describe, expect, it } from "vitest";
import { LlmError } from "../src/llm/client";
import { loadSettings, type LlmSettings } from "../src/llm/providers";
import { dashscopeOrigin, refineImage, refineSize, REFINE_PROMPT } from "../src/llm/refine";

const qwen: LlmSettings = { provider: "qwen", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", visionModel: "", imageModel: "qwen-image-2.1-pro", apiKey: "sk-test" };

describe("AI 精修", () => {
  it("只认阿里云百炼的地址（兼容模式地址、国际站、业务空间专属域名），别家返回 null", () => {
    expect(dashscopeOrigin(qwen.baseURL)).toBe("https://dashscope.aliyuncs.com");
    expect(dashscopeOrigin("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe("https://dashscope-intl.aliyuncs.com");
    expect(dashscopeOrigin("https://ws123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")).toBe("https://ws123.cn-beijing.maas.aliyuncs.com");
    expect(dashscopeOrigin("https://api.deepseek.com")).toBeNull();
    expect(dashscopeOrigin("https://evil-dashscope.aliyuncs.com.example.com")).toBeNull();
    expect(dashscopeOrigin("不是网址")).toBeNull();
  });
  it("出图尺寸：长边缩到 1536，比例不变，都是 16 的倍数", () => {
    expect(refineSize(1920, 1253)).toEqual([1536, 1008]);
    expect(refineSize(1280, 952)).toEqual([1280, 960]);
    for (const v of refineSize(894, 1280)) expect(v % 16).toBe(0);
  });
  it("请求格式：百炼原生图像编辑接口，图和指令放在同一条消息里，关掉提示词改写和水印；返回结果图网址", async () => {
    let url = "", body: any, auth = "";
    const f = (async (u: string, init: RequestInit) => {
      url = u; body = JSON.parse(String(init.body)); auth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://oss.example/r.png" }] } }] } }));
    }) as unknown as typeof fetch;
    const out = await refineImage(qwen, "data:image/jpeg;base64,AAA", [1536, 1008], { fetchFn: f });
    expect(out).toBe("https://oss.example/r.png");
    expect(url).toBe("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    expect(auth).toBe("Bearer sk-test");
    expect(body.model).toBe("qwen-image-2.1-pro");
    expect(body.input.messages[0].content).toEqual([{ image: "data:image/jpeg;base64,AAA" }, { text: REFINE_PROMPT }]);
    expect(body.parameters).toMatchObject({ n: 1, watermark: false, prompt_extend: false, size: "1536*1008" });
  });
  it("别家厂商、没填图像模型：不发请求，直接说明", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    await expect(refineImage({ ...qwen, provider: "deepseek", baseURL: "https://api.deepseek.com" }, "data:", [512, 512], { fetchFn: f })).rejects.toThrow(/只支持通义千问/);
    await expect(refineImage({ ...qwen, imageModel: "" }, "data:", [512, 512], { fetchFn: f })).rejects.toThrow(/图像模型/);
    expect(called).toBe(false);
  });
  it("厂商报错时把状态码和原因说清楚", async () => {
    const f = (async () => new Response(JSON.stringify({ code: "InvalidParameter", message: "Model not exist." }), { status: 404 })) as unknown as typeof fetch;
    await expect(refineImage(qwen, "data:", [512, 512], { fetchFn: f })).rejects.toThrow(LlmError);
    await expect(refineImage(qwen, "data:", [512, 512], { fetchFn: f })).rejects.toThrow(/HTTP 404，模型名不对或这个账号没开通它）：Model not exist/);
  });
  it("以前存的设置没有图像模型：按厂商默认值补上", () => {
    const store = { getItem: () => JSON.stringify({ provider: "qwen", baseURL: qwen.baseURL, model: "qwen-plus", visionModel: "", apiKey: "k" }) };
    expect(loadSettings(store).imageModel).toBe("qwen-image-2.1-pro");
  });
});
