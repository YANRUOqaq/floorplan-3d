/**
 * 一次对话：发提示词 → 解析 JSON → 格式不对就把错误发回去让它改一次 → 套用到方案草稿上。
 * 草稿不直接生效，界面上让用户看清要改什么、有哪些摆放问题，点“应用”才提交（可撤销）。
 */
import { applyOps, LlmReply, refProblems, type ApplyResult } from "../model/ops";
import { formatIssues, type House } from "../model/schema";
import { chat, extractJson, LlmError, type ChatMessage } from "./client";
import type { LlmSettings } from "./providers";
import { catalogText, SYSTEM_PROMPT, userMessage } from "./prompt";

export interface Turn { role: "user" | "assistant"; text: string }
export interface AskResult { reply: LlmReply; preview: ApplyResult | null; repaired: boolean }

function parse(text: string, house: House): { ok: true; value: LlmReply } | { ok: false; error: string } {
  let raw: unknown;
  try { raw = extractJson(text); } catch (e) { return { ok: false, error: `不是合法的 JSON：${(e as Error).message}` }; }
  const r = LlmReply.safeParse(raw);
  if (!r.success) return { ok: false, error: formatIssues(r.error) };
  // 格式对了，但 beside / on 的引用找不到或分不清：发回去改一次
  const bad = refProblems(house, r.data.ops);
  if (bad.length) return { ok: false, error: `place 里的引用有问题：${bad.join("；")}。引用这次新加的家具，用“类型+序号”（这次第一张床是 bed1），或者在那条 add 里写 "ref" 起个和已有 id 不重的名字；被引用的要写在前面。引用已有的家具用它的 id。` };
  return { ok: true, value: r.data };
}

/** history 只带前几轮的文字（用户的话和大模型的说明），方案本身每轮重新描述 */
export async function askAssistant(s: LlmSettings, house: House, history: Turn[], text: string, opts: { signal?: AbortSignal; fetchFn?: typeof fetch } = {}): Promise<AskResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + "\n\n" + catalogText() },
    ...history.slice(-8).map(t => ({ role: t.role, content: t.text }) as ChatMessage),
    { role: "user", content: userMessage(house, text) },
  ];
  const first = await chat(s, messages, { json: true, signal: opts.signal, fetchFn: opts.fetchFn });
  let parsed = parse(first, house), repaired = false;
  if (!parsed.ok) {
    // 格式不对：把错误原样发回去，让它只改格式再给一次。只重试这一次，再错就报给用户
    repaired = true;
    const second = await chat(s, [...messages, { role: "assistant", content: first }, { role: "user", content: `你的回复不符合要求的格式：\n${parsed.error}\n请只输出修正后的完整 JSON 对象。` }], { json: true, signal: opts.signal, fetchFn: opts.fetchFn });
    parsed = parse(second, house);
    if (!parsed.ok) throw new LlmError(`大模型两次都没按格式回复：\n${parsed.error}`);
  }
  const reply = parsed.value;
  let preview: ApplyResult | null = null;
  if (reply.ops.length) {
    try { preview = applyOps(house, reply.ops); }
    catch (e) { throw new LlmError(`大模型给的修改套用后方案不合格：${(e as Error).message}`); }
  }
  return { reply, preview, repaired };
}
