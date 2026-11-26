/**
 * 户型图识别：本地先在像素里找墙、洞口、房间（model/raster.ts，一两秒、不花钱），再调两次识图模型读它擅长的东西，最后融合（model/fuse.ts）。
 *
 * 实测后的分工：识图模型（qwen3-vl-plus）读得对尺寸数字、认得出房间名和门窗类型，但给不准位置
 * （2026-11-25：房间边界常差 0.3~1.2 m，尺寸数字的位置是编的；2026-11-26：有一张真实图干脆把毫米数当坐标报了回来）。所以：
 * - 整张图读尺寸链（只要数字，不要位置），顺便抄下图上印着的面积数字（用来分辨它报的房间面积是不是编的）；
 * - 框出的一户：程序给找到的每个房间涂淡色、画圆圈数字，每个洞口旁画蓝底字母，模型只回答“几号是什么房间、哪个字母是什么门窗”
 *   （做法叫 Set-of-Mark）。位置全由程序定，模型不用报坐标。
 *   2026-11-26 十张真实图上，原来让模型报房间多边形再按重叠对号入座，房间类型只对了 23/66。
 * - 像素里一个房间都没围出来（比如墙画成空心双线）时，退回让模型报房间多边形（坐标用 0~1000 的相对坐标，Qwen3-VL 训练时就用这种）。
 * 两次调用同时发。只发框出的一户认房间：整张图发过去，模型会把邻居家的墙混进来（2026-11-24 实测）。
 */
import { z } from "zod";
import type { Background, Vec2 } from "../model/schema";
import { ROOM_TYPES } from "../model/schema";
import { buildDraft, type Chain } from "../model/draft";
import { estimateScale, type ScaleResult } from "../model/scale";
import { detectPlan, type Detection } from "../model/raster";
import { areasOnPixelRooms, fuse, markAnchor, wallRuns, type VlmOpening, type VlmRoom } from "../model/fuse";
import { pointInPolygon } from "../model/geometry";
import { chat, extractJson, LlmError } from "./client";
import type { LlmSettings } from "./providers";

export const NORM = 1000;
/** 点：模型偶尔多给一个数（[x, y, 0]），只取前两个 */
const P = z.array(z.number()).min(2).transform(a => [a[0], a[1]] as Vec2);
/** 多边形：模型偶尔把点摊平成 [x1, y1, x2, y2, ...]，或者再包一层（2026-11-26 十张真实户型图里有两张这样） */
const Polygon = z.array(z.unknown()).transform((a, ctx) => {
  const pts: Vec2[] = [];
  if (a.length >= 3 && a.every(p => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number")) for (const p of a as number[][]) pts.push([p[0], p[1]]);
  else { const n = a.flat(2).filter((v): v is number => typeof v === "number"); for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]); }
  if (pts.length < 3) { ctx.addIssue({ code: "custom", message: "多边形少于 3 个点" }); return z.NEVER; }
  return pts;
});
/** 一组里有一项格式不对就只丢这一项，不让整次识别失败 */
const itemsOf = <T extends z.ZodType>(item: T) => z.array(z.unknown()).default([]).transform(a => a.flatMap(x => { const r = item.safeParse(x); return r.success ? [r.data as z.output<T>] : []; }));

export const ChainsReply = z.object({
  chains: itemsOf(z.object({ dir: z.enum(["h", "v"]), mm: z.array(z.number().nullable()).min(1), total: z.number().nullable().optional() })),
  areas: itemsOf(z.number()),
});
const Id = z.union([z.number(), z.string()]).transform(v => String(v).trim().toUpperCase());
export const MarksReply = z.object({
  rooms: itemsOf(z.object({ id: Id, name: z.string(), type: z.string().optional(), area: z.number().nullable().optional() })),
  openings: itemsOf(z.object({ id: Id, type: z.enum(["door", "entry", "sliding", "window", "opening", "none"]) })),
  missing: itemsOf(z.string()),
});
export const RoomsReply = z.object({
  rooms: itemsOf(z.object({ name: z.string(), type: z.string().optional(), polygon: Polygon, area: z.number().nullable().optional() })),
  openings: itemsOf(z.object({ type: z.enum(["door", "entry", "sliding", "window", "opening"]), at: P, width: z.number().nullable().optional(), rooms: z.array(z.string()).optional() })),
});
export type ChainsReply = z.infer<typeof ChainsReply>;
export type RoomsReply = z.infer<typeof RoomsReply>;
export type MarksReply = z.infer<typeof MarksReply>;

export function chainsPrompt() {
  return `这是一张住宅户型图。请读出图上所有横着和竖着的尺寸标注链：一排连续的尺寸数字（单位毫米），旁边有尺寸线和短刻度。斜着的不要。
格式：{"chains":[{"dir":"h 或 v","mm":[数字,...],"total":这排尺寸的总长}],"areas":[面积数字,...]}
- dir：h 是横着的一排，数字从左到右写；v 是竖着的一列，数字从上到下写。
- 一排里的数字一个都不要跳过；看不清的写 null。数字照图上写的抄，不要换算，不要自己改。
- 这排尺寸外侧如果还有一个标总长的数字，写在 total；没有就不写。同一排尺寸只列一次。只有一个数的总尺寸也列出来（mm 里只写这一个数）。
- 另外把图上印着的所有面积数字（后面带 ㎡ 或 m² 的）按出现的顺序抄在 areas 里，例如 [25.7, 4.4]；图上没有就写 []，不要自己估。
只输出一个 JSON 对象：{"chains":[...],"areas":[...]}，不要别的文字。`;
}

export function roomsPrompt() {
  return `这是一张住宅户型图，只截了一户。坐标用相对坐标：把图片的宽和高都看成 ${NORM}，左上角是 (0, 0)，x 向右，y 向下。
请识别这一户的每个房间和门窗，只输出一个 JSON 对象：
{"rooms":[{"name":"房间名","type":"${ROOM_TYPES.join("|")}","polygon":[[x,y],...],"area":图上标的面积}],
 "openings":[{"type":"door|entry|sliding|window|opening","at":[x,y],"width":洞口宽度,"rooms":["一边的房间名","另一边的房间名"]}]}
要求：
- 房间要把这一户铺满：客厅、餐厅、卧室、厨房、卫生间、阳台，还有过道、玄关这类没写名字的空间，都要给（没写名字的按用途起名）。
- polygon 沿墙按顺序给出房间的各个角；矩形房间给 4 个角。
- area 是图上写在这个房间里的面积数字（平方米），没写就不写。
- 门窗：平开门 door，入户门 entry，推拉门 sliding，没有门扇的门洞 opening，窗 window（阳台的窗也是）。at 是洞口中心，width 是洞口宽度（按图片宽度算的相对长度）。rooms 写门窗两边的房间名，通到户外或楼道的那一边写“外面”。
- 只识别这一户；图片边上露出来的邻居家不要。家具、尺寸标注线、轴线编号都不是墙。
- 不确定的部分宁可不给。只输出 JSON，不要别的文字。`;
}

export function marksPrompt(rooms: number, gaps: number) {
  const letters = gaps ? `A~${markId(gaps - 1)}` : "";
  return `这是一张住宅户型图，只截了一户。程序已经在图上找出了房间和门窗洞口并做了标记：
- 每个房间涂了一层淡淡的颜色（一个颜色一个房间），房间里有一个同色的圆圈数字 1~${rooms}；
${gaps ? `- 蓝底白字的方块字母 ${letters} 标在每个门窗洞口旁边。
` : ""}请只输出一个 JSON 对象：
{"rooms":[{"id":1,"name":"房间名","type":"${ROOM_TYPES.join("|")}","area":面积}],
 "openings":[{"id":"A","type":"door|entry|sliding|window|opening|none"}],
 "missing":["图上有、但没涂颜色、没有数字的房间名"]}
要求：
- 每个圆圈数字都要给。name 照这个房间（这片颜色）里写的抄（比如“主卧”“卫生间A”）；没写名字的，按家具和位置判断用途起名（有床是卧室，有灶台是厨房，有马桶是卫生间）。
- 一片颜色里写了两个名字（比如“客厅”和“餐厅”），name 写“客餐厅”，type 用 living。
- area 只抄这个房间里印着的面积数字（平方米）；图上没印就不写，不要估。
${gaps ? `- 每个字母都要给。门窗：平开门 door，入户门 entry（通到楼道或入户花园的那扇），推拉门 sliding，没有门扇的门洞 opening，窗 window（飘窗、阳台的窗也是）；标错了、那里不是门窗的写 none。
` : ""}- 只输出 JSON，不要别的文字。`;
}

/** 洞口的字母编号：A~Z，再往后 AA、AB…… */
export const markId = (i: number): string => i < 26 ? String.fromCharCode(65 + i) : markId(Math.floor(i / 26) - 1) + markId(i % 26);

/** 画在发给模型那张图上的标记：每个房间、每个洞口的编号和位置（原图像素）。位置存下来，重新检测后还能按位置对上 */
export interface Marks { rooms: { id: string; at: Vec2 }[]; gaps: { id: string; at: Vec2 }[] }

/** 发给模型的一张图：url 是 data URL，w、h 是这张图的像素尺寸；原图像素 = offset + 这张图的像素 × scale */
export interface SentImage { url: string; w: number; h: number; offset: Vec2; scale: number }

/** 模型读到的东西，坐标已经换成原图像素 */
export interface Reading {
  chains: Chain[]; rooms: VlmRoom[]; openings: VlmOpening[]; ms: number;
  /** 模型说图上有、但没被标出来的房间（像素里没围出来） */
  missing?: string[];
  /** 图上印着的面积数字（读尺寸那次一起抄的）；模型报的房间面积不在这里面的，多半是它估的 */
  areaLabels?: number[];
  /** 模型的原始回复，评测时存档、查问题用 */
  raw: { chains: unknown; rooms: unknown };
}

async function ask<T>(s: LlmSettings, prompt: string, img: SentImage, schema: z.ZodType<T>, what: string, opts: { signal?: AbortSignal; fetchFn?: typeof fetch }): Promise<T> {
  const text = await chat(s, [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: img.url } }] }], { model: s.visionModel, signal: opts.signal, fetchFn: opts.fetchFn });
  let raw: unknown;
  try { raw = extractJson(text); } catch { throw new LlmError(`识图模型${what}时没有返回 JSON。可以换一个识图模型再试。`); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new LlmError(`识图模型${what}时返回的格式不对：` + r.error.issues.slice(0, 3).map(i => i.path.join(".") + " " + i.message).join("；"));
  return r.data;
}

/** 相对坐标 → 原图像素 */
const toPx = (img: SentImage) => (p: Vec2): Vec2 => [img.offset[0] + p[0] / NORM * img.w * img.scale, img.offset[1] + p[1] / NORM * img.h * img.scale];

/**
 * 两次调用同时发：整张图读尺寸数字和面积；框出的一户认房间和门窗。
 * marks 有内容时（像素里围出了房间），unit 是画了标记的图，模型按编号回答；没有时让模型报房间多边形（退路）。
 */
export async function readPlan(s: LlmSettings, full: SentImage, unit: SentImage, opts: { marks?: Marks | null; signal?: AbortSignal; fetchFn?: typeof fetch } = {}): Promise<Reading> {
  if (!s.visionModel) throw new LlmError("还没填识图模型。在“大模型”面板的设置里填一个能看图的模型（比如通义千问的 qwen3-vl-plus）。");
  const t0 = Date.now(), marks = opts.marks?.rooms.length ? opts.marks : null;
  const [ch, rm] = await Promise.all([
    ask(s, chainsPrompt(), full, ChainsReply, "读尺寸", opts),
    marks ? ask(s, marksPrompt(marks.rooms.length, marks.gaps.length), unit, MarksReply, "认房间", opts) : ask(s, roomsPrompt(), unit, RoomsReply, "认房间", opts),
  ]);
  const chains = ch.chains.map(c => ({ dir: c.dir, mm: c.mm, ...(c.total ? { total: c.total } : {}) }));
  const base = { chains, areaLabels: ch.areas, ms: 0, raw: { chains: ch, rooms: rm } };
  if (marks) {
    const r = rm as MarksReply, at = new Map([...marks.rooms, ...marks.gaps].map(m => [m.id, m.at]));
    return {
      ...base,
      rooms: r.rooms.flatMap(x => { const p = at.get(x.id); return p && marks.rooms.some(m => m.id === x.id) ? [{ name: x.name, type: x.type, at: p, ...(x.area ? { area: x.area } : {}) }] : []; }),
      openings: r.openings.flatMap(x => { const p = at.get(x.id); return p && marks.gaps.some(m => m.id === x.id) ? [{ type: x.type, at: p }] : []; }),
      missing: r.missing,
      ms: Date.now() - t0,
    };
  }
  const r = rm as RoomsReply, up = toPx(unit);
  return {
    ...base,
    rooms: r.rooms.map(x => ({ name: x.name, type: x.type, polygon: x.polygon.map(up), ...(x.area ? { area: x.area } : {}) })),
    openings: r.openings.map(o => ({ type: o.type, at: up(o.at), ...(o.width ? { widthPx: o.width / NORM * unit.w * unit.scale } : {}), rooms: o.rooms })),
    ms: Date.now() - t0,
  };
}

export interface Draft {
  walls: ReturnType<typeof buildDraft>["walls"];
  rooms: ReturnType<typeof buildDraft>["rooms"];
  /** 底图标定：草稿的坐标 = 原图像素 / 比例，所以原点就是图的左上角 */
  background: Pick<Background, "pxPerM" | "pxPerMz" | "origin">;
  /** 比例从哪来：尺寸链对墙、总尺寸对外墙、房间面积、用户标定 */
  scaleFrom: ScaleResult["from"];
  /** 墙从哪来：pixels 是从像素里找的（准）；model 是模型给的多边形（退路，只当草稿） */
  wallsFrom: "pixels" | "model";
  problems: string[];
}

/**
 * 读到的东西 + 像素检测 → 草稿。比例先算（scale.ts：尺寸链对墙中线、总尺寸对外墙、面积互相核对，只要像素里找到了墙就能用）；
 * 像素里找到了墙和房间就用它（fuse）；找不到房间（比如墙画成空心双线）就退回模型给的多边形。
 * chains 可以是用户改过数字的（识别结果里能改读错的尺寸），所以和 readPlan 分开。
 */
export function draftFromReading(r: Pick<Reading, "chains" | "rooms" | "openings" | "missing" | "areaLabels">, det: Detection | null, manual: { pxPerM: number; pxPerMz?: number } | null, H = 2.75): Draft {
  const pixels = !!det && det.walls.length >= 4 && det.rooms.length >= 1;
  // 模型报的房间面积，读尺寸那次抄下的面积数字里也有，才算图上印着的；图上一个面积都没印（areaLabels 是空的），它报的全是估的。
  // 2026-11-26 十张真实图里 6 张图上没写面积，模型照样报了，而且彼此还挺一致（按图上比例估的），只靠一致性分不出来
  const printed = (a?: number) => !!a && (!r.areaLabels || r.areaLabels.some(x => Math.abs(x - a) < 0.051));
  const rooms = r.rooms.map(v => printed(v.area) ? v : { ...v, area: undefined });
  const areaRooms = pixels ? areasOnPixelRooms(det!, rooms) : rooms.flatMap(v => v.polygon && v.area ? [{ polygon: v.polygon, area: v.area }] : []);
  let sc: ScaleResult;
  try { sc = estimateScale(det && det.walls.length >= 2 ? det : null, r.chains, areaRooms, manual, !!r.areaLabels); }
  catch (e) { throw new LlmError((e as Error).message); }
  if (pixels) {
    const f = fuse(det!, sc, rooms, r.openings, H, r.missing);
    return { walls: f.walls, rooms: f.rooms, background: { pxPerM: f.sx, pxPerMz: f.sz, origin: [0, 0] }, scaleFrom: sc.from, wallsFrom: "pixels", problems: f.problems };
  }
  const { sx, sz } = sc;
  const problems = ["图上没找到围成房间的实心墙线（可能墙画成了空心的双线，或者图太小、太糊），墙是按模型给的房间范围生成的，误差会比较大，请对照底图逐面检查。", ...sc.problems];
  const m = (p: Vec2): Vec2 => [p[0] / sx, p[1] / sz];
  const d = buildDraft(
    rooms.flatMap(g => g.polygon ? [{ ...g, polygon: g.polygon.map(m) }] : []),
    // 门窗宽度是按图片宽度给的，不知道门窗是横的还是竖的，横竖比例差不多，取平均
    r.openings.flatMap(o => o.type === "none" ? [] : [{ type: o.type, at: m(o.at), rooms: o.rooms, ...(o.widthPx ? { width: o.widthPx / ((sx + sz) / 2) } : {}) }]),
    { xs: [], zs: [] }, H,
  );
  return { walls: d.walls, rooms: d.rooms, background: { pxPerM: sx, pxPerMz: sz, origin: [0, 0] }, scaleFrom: sc.from, wallsFrom: "model", problems: [...problems, ...d.problems] };
}

/**
 * 浏览器里准备发给模型的两张图：
 * - 整张图（读尺寸）只缩小不放大，长边最多 2048。2026-11-25 试过放大到 3072：小字读对的多了，
 *   但模型给的位置乱了；现在不要位置了，但放大也费钱，单户的户型图原尺寸一般就看得清数字。
 * - 框出的一户（认房间）放大或缩小到长边 1280：户型图里一户常常只有两三百像素，太小模型看不清，太大又费钱。
 *   det 里有房间时，在这张图上画编号：每个房间涂一层淡色、放一个同色圆圈数字（离墙够远、避开房间正中，别挡住房间名），
 *   每个洞口旁一个蓝底字母（放在洞口一侧，别挡住门扇和窗线）。marks 记下每个编号对应的原图位置。
 */
export async function prepareImages(blob: Blob, crop: [number, number, number, number] | null, det: Detection | null = null): Promise<{ full: SentImage; unit: SentImage; marks: Marks | null }> {
  const bmp = await createImageBitmap(blob);
  const draw = (x0: number, y0: number, w: number, h: number, k: number, extra?: (g: CanvasRenderingContext2D) => void): SentImage => {
    const cw = Math.round(w * k), ch = Math.round(h * k);
    const c = document.createElement("canvas"); c.width = cw; c.height = ch;
    const g = c.getContext("2d")!; g.imageSmoothingQuality = "high"; g.fillStyle = "#fff"; g.fillRect(0, 0, cw, ch);
    g.drawImage(bmp, x0, y0, w, h, 0, 0, cw, ch);
    extra?.(g);
    return { url: c.toDataURL("image/jpeg", 0.9), w: cw, h: ch, offset: [x0, y0], scale: 1 / k };
  };
  const W = bmp.width, H = bmp.height, [x0, y0, x1, y1] = crop ?? [0, 0, W, H];
  const full = draw(0, 0, W, H, Math.min(1, 2048 / Math.max(W, H)));
  const k = 1280 / Math.max(x1 - x0, y1 - y0);
  let marks: Marks | null = null;
  const unit = draw(x0, y0, x1 - x0, y1 - y0, k, det?.rooms.length ? g => { marks = drawMarks(g, det, [x0, y0], k); } : undefined);
  bmp.close();
  return { full, unit, marks };
}

/** 在发给模型的图上画编号（g 的坐标 = (原图像素 - offset) × k），返回每个编号在原图上的位置 */
function drawMarks(g: CanvasRenderingContext2D, det: Detection, offset: Vec2, k: number): Marks {
  const S = (p: Vec2): Vec2 => [(p[0] - offset[0]) * k, (p[1] - offset[1]) * k];
  const R = 13, B = 10;   // 房间圆圈半径、洞口方块半边长（发出去的图上的像素）
  g.textAlign = "center"; g.textBaseline = "middle"; g.lineWidth = 2;
  // 每个房间涂一层淡色（同一间同一个颜色、相邻的颜色错开），模型才看得出一个编号管多大一片：
  // 只画编号时，L 形客厅的编号落在过道那头，模型会叫它“过道”
  const hue = (i: number) => (i * 137.5) % 360;
  det.rooms.forEach((r, i) => {
    g.fillStyle = `hsla(${hue(i)}, 85%, 55%, 0.2)`;
    g.beginPath(); r.polygon.forEach((p, j) => { const q = S(p); if (j) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.closePath(); g.fill();
  });
  const label = (p: Vec2, text: string, round: boolean, color: string) => {
    const [x, y] = S(p), r = round ? R : B;
    g.fillStyle = color; g.strokeStyle = "#fff";
    g.beginPath();
    if (round) g.arc(x, y, r, 0, Math.PI * 2); else g.rect(x - r - (text.length - 1) * 4, y - r, 2 * r + (text.length - 1) * 8, 2 * r);
    g.fill(); g.stroke();
    g.fillStyle = "#fff"; g.font = `bold ${round ? 15 : 13}px sans-serif`;
    g.fillText(text, x, y + 1);
  };
  const rooms = det.rooms.map((r, i) => ({ id: String(i + 1), at: markAnchor(r.polygon, (R + 4) / k) }));
  // 只标会变成门窗的洞口（连在墙线上的，见 fuse.ts 的 wallRuns），一个洞口一个字母，位置记洞口中心：
  // 2026-11-26 真实图上检测出的空缺有 20~57 个，大半是衣柜、家具细线里的，全标上字母会糊成一片
  const holes = wallRuns(det).flatMap(r => r.holes.map(hl => ({ h: r.h, c: r.c, lo: hl.lo, hi: hl.hi, t: r.t })));
  const gaps = holes.map((hl, i) => {
    const c: Vec2 = hl.h ? [(hl.lo + hl.hi) / 2, hl.c] : [hl.c, (hl.lo + hl.hi) / 2];
    // 字母放在洞口一侧（优先落在房间里的那一侧），离墙中线半个墙厚再加一个方块
    const off = hl.t / 2 + (B + 3) / k;
    const sides: Vec2[] = hl.h ? [[c[0], c[1] - off], [c[0], c[1] + off]] : [[c[0] - off, c[1]], [c[0] + off, c[1]]];
    const at = sides.find(p => det.rooms.some(r => pointInPolygon(p, r.polygon))) ?? sides[0];
    return { id: markId(i), at: c, drawAt: at };
  });
  for (const m of gaps) label(m.drawAt, m.id, false, "#1f5fbf");
  rooms.forEach((m, i) => label(m.at, m.id, true, `hsl(${hue(i)}, 80%, 32%)`));
  return { rooms, gaps: gaps.map(({ id, at }) => ({ id, at })) };
}

/**
 * 在框出的一户里从像素找墙（不调接口）。图太大时先缩到长边 2000 像素（够准，也够快）；
 * 一户太小（长边不到 600 像素）时放大到 600，墙太薄找不准。结果换回原图像素。
 */
export async function detectInImage(blob: Blob, crop: [number, number, number, number] | null): Promise<Detection> {
  const bmp = await createImageBitmap(blob);
  const [x0, y0, x1, y1] = crop ?? [0, 0, bmp.width, bmp.height], w = x1 - x0, h = y1 - y0;
  const k = Math.min(2000 / Math.max(w, h), Math.max(1, 600 / Math.max(w, h)));
  const cw = Math.round(w * k), ch = Math.round(h * k);
  const c = document.createElement("canvas"); c.width = cw; c.height = ch;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, cw, ch);
  g.drawImage(bmp, x0, y0, w, h, 0, 0, cw, ch);
  bmp.close();
  const rgba = g.getImageData(0, 0, cw, ch).data, data = new Uint8Array(cw * ch);
  // 灰度取三个通道里最亮的那个：墙是黑或深灰（三个通道都暗），红箭头、彩色水印、木地板这类彩色的东西只有一两个通道暗，
  // 按亮度算会变成深灰、被当成墙（2026-11-26 贝壳图上的红箭头就是这样）
  for (let i = 0; i < data.length; i++) data[i] = Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  const d = detectPlan({ w: cw, h: ch, data });
  const P = (p: [number, number]): [number, number] => [x0 + p[0] / k, y0 + p[1] / k];
  return {
    walls: d.walls.map(x => ({ ...x, a: P(x.a), b: P(x.b), t: x.t / k })),
    gaps: d.gaps.map(x => ({ ...x, a: P(x.a), b: P(x.b), t: x.t / k })),
    rooms: d.rooms.map(r => ({ polygon: r.polygon.map(P), area: r.area / k / k })),
    wallThickness: d.wallThickness / k,
  };
}
