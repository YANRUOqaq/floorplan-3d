/**
 * 大模型厂商预设。都用 OpenAI 兼容的 /chat/completions 接口，所以一套调用代码就够。
 * 2026-11-24 实测这几家的接口允许浏览器直接调用（CORS），智谱不允许，所以没列。
 * 模型名会更新，这里只是默认值；设置里可以点“获取模型列表”从厂商那里读当前可用的模型。
 */
export interface Provider {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  /** 能看图的模型（户型图识别用），没有就留空 */
  visionModel: string;
  /** 图像编辑模型（出效果图里的 AI 精修用），目前只有通义千问接了，别家留空 */
  imageModel: string;
  keyUrl: string;
}

export const PROVIDERS: Provider[] = [
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com", model: "deepseek-chat", visionModel: "", imageModel: "", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "qwen", name: "通义千问（阿里云百炼）", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", visionModel: "qwen3-vl-plus", imageModel: "qwen-image-2.1-pro", keyUrl: "https://bailian.console.aliyun.com/" },
  { id: "kimi", name: "Kimi（月之暗面）", baseURL: "https://api.moonshot.cn/v1", model: "kimi-latest", visionModel: "kimi-latest", imageModel: "", keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  { id: "doubao", name: "豆包（火山方舟）", baseURL: "https://ark.cn-beijing.volces.com/api/v3", model: "", visionModel: "", imageModel: "", keyUrl: "https://console.volcengine.com/ark" },
  { id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini", visionModel: "gpt-4o-mini", imageModel: "", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "custom", name: "其他（OpenAI 兼容接口）", baseURL: "", model: "", visionModel: "", imageModel: "", keyUrl: "" },
];

export interface LlmSettings { provider: string; baseURL: string; model: string; visionModel: string; imageModel: string; apiKey: string }

const KEY = "floorplan-3d:llm";
export function loadSettings(storage: Pick<Storage, "getItem"> = localStorage): LlmSettings {
  try {
    const s = JSON.parse(storage.getItem(KEY) ?? "null");
    // 以前存的设置没有 imageModel：按厂商默认值补上
    if (s && typeof s.baseURL === "string") return { provider: s.provider ?? "custom", baseURL: s.baseURL, model: s.model ?? "", visionModel: s.visionModel ?? "", imageModel: s.imageModel ?? PROVIDERS.find(p => p.id === s.provider)?.imageModel ?? "", apiKey: s.apiKey ?? "" };
  } catch { /* 存的东西坏了就当没有 */ }
  const p = PROVIDERS[0];
  return { provider: p.id, baseURL: p.baseURL, model: p.model, visionModel: p.visionModel, imageModel: p.imageModel, apiKey: "" };
}
export function saveSettings(s: LlmSettings, storage: Pick<Storage, "setItem"> = localStorage) { storage.setItem(KEY, JSON.stringify(s)); }
export function clearKey(storage: Pick<Storage, "getItem" | "setItem"> = localStorage) { const s = loadSettings(storage); s.apiKey = ""; saveSettings(s, storage); }
