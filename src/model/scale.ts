/**
 * 比例（每米多少像素）：几路证据互相核对，挑最可信的。纯计算，有单元测试。
 *
 * 2026-11-26 在 10 张真实户型图上实测，原来“尺寸链对墙中线，对不上就用模型报的房间面积”只有 3 张比例在 3% 以内：
 * - 模型会把竖着的尺寸链说成横的（于是对到了错的墙上，比例差 20%）；
 * - 模型会编面积：10 张里 6 张图上根本没写面积，它照样报了，按面积算的比例差 26%~600%；
 * - 只标了总尺寸的图（一个数），尺寸链用不上；
 * - 像素里找到了墙、但没围成房间时，原来直接退回面积，墙明明在也没用上。
 * 现在：
 * 1. 尺寸链：每条链横竖两个方向都试着对墙中线（matchAxes），取对上多的；各条链算出的比例相差 6% 以内的归一组，取分量最重的一组。
 * 2. 总尺寸：只有一个数的尺寸（和各链的总长）对外墙的跨度（两种量法，见 outerSpan）。横竖都有时挑最一致的一对（5% 内）。
 * 3. 面积：模型报的面积配到像素房间上，每间算一个比例；至少 3 间、而且彼此一致（四分位比 ≤ 1.2）才用。
 *    printed 表示这些面积确认是图上印着的（读尺寸那次也抄到了同样的数）：印着的面积可以纠正分量轻的尺寸链和总尺寸；
 *    没确认的只在别的都没有时用——模型估出来的面积彼此也挺一致（按图上比例估的），2026-11-26 实测按它算差 26%。
 * 4. 每个候选都要说得通：墙厚换算成 5~45 cm，整套的外框面积 12~800 ㎡。
 * 尺寸链 > 总尺寸 > 面积 > 手动标定。尺寸链只有一个方向、分量又轻时，和图上印着的面积差 15% 以上就信面积（贝壳图的面积是量出来的）。
 */
import type { Vec2 } from "./schema";
import { polygonArea } from "./geometry";
import { axesOf, checkChains, matchAxes, type Chain } from "./draft";
import type { Detection } from "./raster";

export interface ScaleResult {
  sx: number; sz: number;
  from: "chains" | "overall" | "areas" | "manual";
  problems: string[];
}

type Dir = "h" | "v";
const other = (d: Dir): Dir => d === "h" ? "v" : "h";

/** 墙中线按位置聚成“墙线”（同一条线上被门窗隔开的几段算一条），返回每条线的位置和总长 */
function wallLines(det: Detection, d: Dir) {
  const segs = det.walls.filter(w => d === "h" ? Math.abs(w.a[0] - w.b[0]) < 1e-6 : Math.abs(w.a[1] - w.b[1]) < 1e-6)   // h 方向的尺寸对竖墙（x）
    .map(w => d === "h" ? { c: w.a[0], len: Math.abs(w.b[1] - w.a[1]) } : { c: w.a[1], len: Math.abs(w.b[0] - w.a[0]) })
    .sort((a, b) => a.c - b.c);
  const lines: { c: number; len: number }[] = [];
  for (const s of segs) {
    const l = lines[lines.length - 1];
    if (l && s.c - l.c <= Math.max(2, det.wallThickness)) { l.c = (l.c * l.len + s.c * s.len) / (l.len + s.len || 1); l.len += s.len; }
    else lines.push({ ...s });
  }
  return lines;
}

/**
 * 外墙跨度（像素）的两种量法：lines 是总长够长的墙线里最外两条的距离（不受空调板、飘窗这类小凸出影响），
 * ends 是够长的墙段端点的最外范围（阳台外沿只画了栏杆细线时，靠两侧墙的端点量到）。2026-11-26 实测两种各有对有错，都当候选。
 */
export function outerSpan(det: Detection, d: Dir): { lines: number; ends: number } {
  const lines = wallLines(det, d), perp = wallLines(det, other(d));
  const span = perp.length >= 2 ? perp[perp.length - 1].c - perp[0].c : Math.max(0, ...lines.map(l => l.len));
  const long = lines.filter(l => l.len >= span * 0.2);
  const k = d === "h" ? 0 : 1, pts = det.walls.filter(w => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) >= 1.5 * det.wallThickness).flatMap(w => [w.a[k], w.b[k]]);
  return { lines: long.length >= 2 ? long[long.length - 1].c - long[0].c : 0, ends: pts.length ? Math.max(...pts) - Math.min(...pts) : 0 };
}

/** 面积估比例：每间一个估计（图上标的是套内面积，按墙中线算大 15% 左右）；不一致返回 null */
export function scaleFromAreas(rooms: { polygon: Vec2[]; area?: number }[]): { s: number; n: number; spread: number } | null {
  const ks = rooms.filter(r => r.area && r.area > 1 && r.polygon.length >= 3)
    .map(r => Math.sqrt(polygonArea(r.polygon) / (r.area! * 1.15))).sort((a, b) => a - b);
  if (ks.length < 3) return null;
  const q1 = ks[Math.floor((ks.length - 1) * 0.25)], q3 = ks[Math.ceil((ks.length - 1) * 0.75)];
  const spread = q3 / q1;
  return spread <= 1.2 ? { s: ks[Math.floor(ks.length / 2)], n: ks.length, spread } : null;
}

export function estimateScale(det: Detection | null, chains: Chain[], areaRooms: { polygon: Vec2[]; area?: number }[], manual: { pxPerM: number; pxPerMz?: number } | null, printed = false): ScaleResult {
  const problems: string[] = [];
  const t = det?.wallThickness ?? 0;
  // 墙厚换算出来要在 5~45 cm 之间；外框面积要像一套房子
  const SH = det ? outerSpan(det, "h") : { lines: 0, ends: 0 }, SV = det ? outerSpan(det, "v") : { lines: 0, ends: 0 };
  const spanH = SH.lines, spanV = SV.lines;
  const plausible = (sx: number, sz = sx) => sx > 0 && sz > 0 && (!det || (t / sx >= 0.05 && t / sx <= 0.45 && (!(spanH && spanV) || (spanH / sx * spanV / sz >= 12 && spanH / sx * spanV / sz <= 800))));

  /* 1. 尺寸链对墙中线，横竖都试 */
  const { usable, problems: chainProblems } = checkChains(chains);
  problems.push(...chainProblems);
  type Fit = { dir: Dir; s: number; n: number; ok: boolean; name: string };
  const fits: Fit[] = [];
  if (det) {
    const lines = { h: det.walls.filter(w => Math.abs(w.a[0] - w.b[0]) < 1e-6).map(w => w.a[0]), v: det.walls.filter(w => Math.abs(w.a[1] - w.b[1]) < 1e-6).map(w => w.a[1]) };
    const tol = Math.max(3, t * 0.4), sMin = t / 0.35, sMax = t / 0.06;
    for (const ch of usable) {
      const name = `尺寸 ${ch.mm.join("、")}`;
      const tries = ([ch.dir, other(ch.dir)] as Dir[]).map(d => ({ d, m: matchAxes(axesOf(ch), lines[d], tol, sMin, sMax) }));
      const best = tries.filter(x => x.m).sort((a, b) => b.m!.matched - a.m!.matched)[0];
      if (best) fits.push({ dir: best.d, s: best.m!.s, n: best.m!.matched, ok: ch.ok, name });
      else problems.push(`${name}：没能和图上的墙对上（可能读错了数字，或者标的不是这一户），没用上`);
    }
  }
  const weight = (f: Fit) => f.n * (f.ok ? 2 : 1);
  const W = (g: Fit[]) => g.reduce((q, f) => q + weight(f), 0);
  const group = fits.map(a => fits.filter(b => Math.abs(b.s / a.s - 1) <= 0.06)).reduce<Fit[]>((best, g) => W(g) > W(best) ? g : best, []);
  const avg = (fs: Fit[]) => fs.length ? fs.reduce((q, f) => q + f.s * f.n, 0) / fs.reduce((q, f) => q + f.n, 0) : 0;
  let chain: { sx: number; sz: number; strong: boolean } | null = null;
  if (group.length) {
    for (const f of fits) if (!group.includes(f)) problems.push(`${f.name}：算出的比例和其他尺寸差了 ${Math.round(Math.abs(f.s / group[0].s - 1) * 100)}%，可能读错了数字，没用上`);
    let sx = avg(group.filter(f => f.dir === "h")), sz = avg(group.filter(f => f.dir === "v"));
    const both = !!(sx && sz);
    if (!sx) sx = sz; if (!sz) sz = sx;
    if (plausible(sx, sz)) chain = { sx, sz, strong: both || W(group) >= 8 };
    else problems.push("尺寸和墙对上的比例换算出来墙厚或面积不合常理，没用上");
  }

  /* 3. 面积（先算好，用来核对尺寸链） */
  const areas = scaleFromAreas(areaRooms);
  const areasOk = areas && plausible(areas.s) ? areas : null;
  if (!areas && areaRooms.filter(r => r.area).length >= 3) problems.push("模型报的房间面积彼此对不上（图上可能没写面积，是它估的），没用来算比例");

  if (chain) {
    if (printed && areasOk && !chain.strong && Math.abs(areasOk.s / ((chain.sx + chain.sz) / 2) - 1) > 0.15) {
      problems.push(`图上的尺寸只对上了一个方向，和房间面积算出的比例差 ${Math.round(Math.abs(areasOk.s / chain.sx - 1) * 100)}%，按面积算的。请核对比例`);
      return { sx: areasOk.s, sz: areasOk.s, from: "areas", problems };
    }
    return { sx: chain.sx, sz: chain.sz, from: "chains", problems };
  }

  /* 2. 总尺寸对外墙跨度 */
  if (det && (spanH || spanV || SH.ends || SV.ends)) {
    const singles = (d: Dir) => [...new Set(chains.filter(c => c.dir === d).flatMap(c => [...(c.mm.length === 1 && c.mm[0] ? [c.mm[0]] : []), ...(c.total ? [c.total] : [])]))];
    const cand = (d: Dir) => { const S = d === "h" ? SH : SV; return singles(d).flatMap(mm => [S.lines, S.ends].filter(Boolean).map((span, i) => ({ mm, s: span / (mm / 1000), lines: i === 0 }))).filter(c => plausible(c.s)); };
    const ch = cand("h"), cv = cand("v");
    let pick: { sx: number; sz: number; sure: boolean } | null = null;
    for (const a of ch) for (const b of cv) if (Math.abs(a.s / b.s - 1) <= 0.05 && (!pick || Math.abs(a.s / b.s - 1) < Math.abs(pick.sx / pick.sz - 1))) pick = { sx: a.s, sz: b.s, sure: true };
    if (!pick) {
      // 只有一个方向（或横竖对不上）：取最大的那个数，总尺寸一般是这一边最大的数
      const c = [...ch, ...cv].filter(c => c.lines).sort((a, b) => b.mm - a.mm)[0];
      if (c) pick = { sx: c.s, sz: c.s, sure: false };
    }
    if (pick) {
      if (printed && areasOk && Math.abs(areasOk.s / pick.sx - 1) > 0.15) {
        problems.push(`总尺寸对外墙算出的比例和房间面积差 ${Math.round(Math.abs(areasOk.s / pick.sx - 1) * 100)}%，按面积算的。请核对比例`);
        return { sx: areasOk.s, sz: areasOk.s, from: "areas", problems };
      }
      problems.push(pick.sure ? "图上的分段尺寸没能用上，比例按总尺寸对外墙算的，误差约一个墙厚（2% 左右）" : "比例按一个总尺寸对外墙算的，没有另一个方向核对，请对照底图检查，必要时用“标定比例”校准");
      return { sx: pick.sx, sz: pick.sz, from: "overall", problems };
    }
  }

  if (areasOk) {
    problems.push(printed ? "没能用上图上的尺寸，比例按图上标的房间面积估的，可能差几个百分点。可以在 2D 编辑里用“标定比例”校准。"
      : "没能用上图上的尺寸，比例按模型报的房间面积估的（没法确认是图上印着的），可能差很多，请用“标定比例”校准。");
    return { sx: areasOk.s, sz: areasOk.s, from: "areas", problems };
  }
  if (manual) return { sx: manual.pxPerM, sz: manual.pxPerMz ?? manual.pxPerM, from: "manual", problems };
  throw new Error("图上没读到能用的尺寸，也没有可信的房间面积，算不出比例。请先在 2D 编辑里用“标定比例”点一段标了尺寸的线，再识别。");
}
