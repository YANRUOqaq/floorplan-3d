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
type Saved = Omit<LlmSettings, "provider">;
/** 存在 localStorage 里的样子：当前选的厂商 + 每家各自的设置和 Key */
interface Stored { current: string; byProvider: Record<string, Saved> }

const KEY = "floorplan-3d:llm";

/**
 * 每家厂商的 Key 分开存。以前只存一份，切换厂商时上一家的 Key 留在输入框里，
 * 下一次请求就把 DeepSeek 的 Key 发给了阿里云（2026-11-25 实测）；也没法同时用 DeepSeek 聊天、用千问识图和精修。
 */
function readStored(storage: Pick<Storage, "getItem">): Stored {
  try {
    const s = JSON.parse(storage.getItem(KEY) ?? "null");
    if (s && typeof s.current === "string" && s.byProvider && typeof s.byProvider === "object") return s;
    // 2026-11-25 之前的格式只存了一家：{ provider, baseURL, model, visionModel, imageModel?, apiKey }。
    // 已经填过 Key 的用户（包括本项目作者）升级后不用重填
    if (s && typeof s.baseURL === "string") {
      const id = s.provider ?? "custom";
      return { current: id, byProvider: { [id]: { baseURL: s.baseURL, model: s.model ?? "", visionModel: s.visionModel ?? "", imageModel: s.imageModel ?? PROVIDERS.find(p => p.id === id)?.imageModel ?? "", apiKey: s.apiKey ?? "" } } };
    }
  } catch { /* 存的东西坏了就当没有 */ }
  return { current: PROVIDERS[0].id, byProvider: {} };
}

/** 读某一家的设置（不给 provider 就是当前选的那家）；没存过的按厂商预设 */
export function loadSettings(storage: Pick<Storage, "getItem"> = localStorage, provider?: string): LlmSettings {
  const st = readStored(storage), id = provider ?? st.current;
  const p = PROVIDERS.find(p => p.id === id), saved = st.byProvider[id];
  return {
    provider: id,
    baseURL: saved?.baseURL ?? p?.baseURL ?? "",
    model: saved?.model ?? p?.model ?? "",
    visionModel: saved?.visionModel ?? p?.visionModel ?? "",
    imageModel: saved?.imageModel ?? p?.imageModel ?? "",
    apiKey: saved?.apiKey ?? "",
  };
}
/** 保存这一家的设置，并把它设成当前选的厂商 */
export function saveSettings(s: LlmSettings, storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
  const st = readStored(storage), { provider, ...rest } = s;
  st.current = provider; st.byProvider[provider] = rest;
  storage.setItem(KEY, JSON.stringify(st));
}
/** 清除所有厂商的 Key（公用电脑上用完点这个） */
export function clearKey(storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
  const st = readStored(storage);
  for (const v of Object.values(st.byProvider)) v.apiKey = "";
  storage.setItem(KEY, JSON.stringify(st));
}
/**
 * 找一家能做这件事的设置：先看当前选的厂商，再按 PROVIDERS 的顺序找填了 Key、而且 ok 的。
 * 识图要能看图的模型，AI 精修要百炼的图像模型；对话用的厂商（比如 DeepSeek）不支持时，自动用填过 Key 的另一家。
 */
export function findSettings(ok: (s: LlmSettings) => boolean, storage: Pick<Storage, "getItem"> = localStorage): LlmSettings | null {
  const st = readStored(storage);
  for (const id of [st.current, ...PROVIDERS.map(p => p.id).filter(id => id !== st.current)]) {
    const s = loadSettings(storage, id);
    if (s.apiKey && ok(s)) return s;
  }
  return null;
}
