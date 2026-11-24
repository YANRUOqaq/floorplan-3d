/**
 * 调用 OpenAI 兼容接口。浏览器直接请求厂商的服务器，Key 只在这个请求的请求头里出现。
 * fetchFn 可以换成假的，单元测试用。
 */
import type { LlmSettings } from "./providers";

export type ChatContent = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
export interface ChatMessage { role: "system" | "user" | "assistant"; content: ChatContent }

export class LlmError extends Error {}

const url = (base: string, path: string) => base.replace(/\/+$/, "") + path;

function check(s: LlmSettings, model: string) {
  if (!s.baseURL) throw new LlmError("还没填接口地址（Base URL）。");
  if (!s.apiKey) throw new LlmError("还没填 API Key。");
  if (!model) throw new LlmError("还没填模型名。可以点“获取模型列表”选一个。");
}

/** 把厂商返回的错误整理成一句人话 */
async function explain(r: Response): Promise<string> {
  let detail = "";
  try { const j = await r.json(); detail = j?.error?.message ?? j?.message ?? JSON.stringify(j).slice(0, 200); } catch { /* 不是 JSON */ }
  const hint = r.status === 401 ? "Key 不对或已失效" : r.status === 402 ? "账户余额不足" : r.status === 404 ? "接口地址或模型名不对；模型会下线换代，可以点“获取模型列表”看现在能用哪些" : r.status === 429 ? "请求太频繁或额度用完了" : r.status >= 500 ? "厂商服务器出错，稍后再试" : "";
  return `请求失败（HTTP ${r.status}${hint ? "，" + hint : ""}）${detail ? "：" + detail : ""}`;
}

export async function chat(s: LlmSettings, messages: ChatMessage[], opts: { model?: string; json?: boolean; signal?: AbortSignal; fetchFn?: typeof fetch } = {}): Promise<string> {
  const model = opts.model ?? s.model;
  check(s, model);
  const body: Record<string, unknown> = { model, messages, temperature: 0.3 };
  if (opts.json) body.response_format = { type: "json_object" };
  let r: Response;
  try {
    r = await (opts.fetchFn ?? fetch)(url(s.baseURL, "/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new LlmError(`连不上 ${s.baseURL}。检查网络和接口地址；如果这家厂商不允许浏览器直接调用（跨域），只能换一家。`);
  }
  if (!r.ok) throw new LlmError(await explain(r));
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new LlmError("厂商返回的内容里没有回复文字。");
  return text;
}

/** 读厂商当前可用的模型名（GET /models） */
export async function listModels(s: LlmSettings, fetchFn: typeof fetch = fetch): Promise<string[]> {
  if (!s.baseURL || !s.apiKey) throw new LlmError("先填接口地址和 API Key。");
  const r = await fetchFn(url(s.baseURL, "/models"), { headers: { Authorization: `Bearer ${s.apiKey}` } });
  if (!r.ok) throw new LlmError(await explain(r));
  const j = await r.json();
  return (j?.data ?? []).map((m: { id: string }) => m.id).filter(Boolean).sort();
}

/** 从回复里取出 JSON：有的模型会包一层 ```json 代码块 */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
  return JSON.parse(body);
}
