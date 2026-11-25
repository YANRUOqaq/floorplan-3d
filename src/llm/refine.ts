/**
 * AI 精修：把路径追踪出的效果图交给通义千问的图像编辑模型（阿里云百炼），做成照片质感的“氛围图”。
 *
 * 为什么只当示意图：图像模型会重新“画”一遍，就算提示词要求保持不变，家具的款式、细节甚至数量也可能变，
 * 生成的图对不上方案里的家具和采购清单。所以界面上标明“AI 示意”，方案本身不受影响。
 *
 * 接口：百炼原生的图像编辑接口（不是 OpenAI 兼容接口），2026-11-25 查官方文档：
 * POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation，
 * 图片可以直接传 data:image/jpeg;base64,…，返回结果图的网址（不支持直接返回图片数据）。
 * 同一天实测这个接口允许浏览器跨域调用（CORS 预检通过）。
 * 价格（2026-11 百炼文档和开发者社区文章）：qwen-image-2.1-turbo 约 0.1 元/张，qwen-image-2.1-pro 约 0.25 元/张。
 */
import { LlmError } from "./client";
import type { LlmSettings } from "./providers";

export const REFINE_PROMPT =
  "这是一张室内装修效果图（三维渲染）。把它变成真实的室内摄影照片：严格保持相机角度、房间结构、门窗位置，" +
  "所有家具的位置、形状、尺寸、数量和颜色都不变，不要增加或删除任何物体；只提升材质质感（木纹、布料纹理、墙面肌理、地板的反光）" +
  "和光影的柔和、真实程度，让它像专业室内摄影师拍的照片。";

/** 百炼的接口地址：从设置里的兼容模式地址推出来；不是百炼就返回 null（别家没有这个接口） */
export function dashscopeOrigin(baseURL: string): string | null {
  try {
    const u = new URL(baseURL);
    return /(^|\.)dashscope(-intl)?\.aliyuncs\.com$|\.maas\.aliyuncs\.com$/.test(u.hostname) ? u.origin : null;
  } catch { return null; }
}

/** 出图尺寸：长边不超过 1536、宽高都是 16 的倍数（接口会自己取整，这里先取好，结果和原图比例一致） */
export function refineSize(w: number, h: number, long = 1536): [number, number] {
  const k = Math.min(1, long / Math.max(w, h));
  const r = (v: number) => Math.max(512, Math.round(v * k / 16) * 16);
  return [r(w), r(h)];
}

/** 发出请求，返回结果图的网址（厂商存 24 小时左右，要长期保存请下载） */
export async function refineImage(s: LlmSettings, imageDataUrl: string, size: [number, number], opts: { signal?: AbortSignal; fetchFn?: typeof fetch } = {}): Promise<string> {
  const origin = dashscopeOrigin(s.baseURL);
  if (!origin) throw new LlmError("AI 精修目前只支持通义千问（阿里云百炼）：在“大模型”面板里选这家厂商并填 Key。");
  if (!s.apiKey) throw new LlmError("还没填 API Key。");
  if (!s.imageModel) throw new LlmError("还没填精修用的图像模型，比如 qwen-image-2.1-pro。");
  const body = {
    model: s.imageModel,
    input: { messages: [{ role: "user", content: [{ image: imageDataUrl }, { text: REFINE_PROMPT }] }] },
    // prompt_extend 关掉：自动改写提示词会加入新的东西，和“保持不变”冲突
    parameters: { n: 1, watermark: false, prompt_extend: false, size: `${size[0]}*${size[1]}` },
  };
  let r: Response;
  try {
    r = await (opts.fetchFn ?? fetch)(origin + "/api/v1/services/aigc/multimodal-generation/generation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new LlmError("连不上阿里云百炼，检查一下网络。");
  }
  const j = await r.json().catch(() => null) as { code?: string; message?: string; output?: { choices?: { message?: { content?: { image?: string }[] } }[] } } | null;
  if (!r.ok) {
    const hint = r.status === 401 ? "Key 不对或已失效" : r.status === 404 ? "模型名不对或这个账号没开通它" : r.status === 429 ? "请求太频繁或额度用完了" : "";
    throw new LlmError(`AI 精修失败（HTTP ${r.status}${hint ? "，" + hint : ""}）${j?.message ? "：" + j.message : ""}`);
  }
  const url = j?.output?.choices?.[0]?.message?.content?.find(c => c.image)?.image;
  if (!url) throw new LlmError("百炼的回复里没有图片。");
  return url;
}
