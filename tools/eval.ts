/**
 * 户型识别评测页（只在 npm run dev 时用，不打包、不发布）：tools/eval.html。
 * 测试图和标准答案放在 local/eval/（带水印、版权不明的图不进仓库），cases.json 列出每一张：
 *   { "name": "01房", "image": "/local/plan.jpg", "crop": [x0, y0, x1, y1] 或 null, "truth": "/examples/01-room.json" 或不填 }
 * 模型读到的原始内容先找 localStorage，再找 local/eval/runs/<name>.reading.json（存档，换台机器、无头浏览器也能重算）。
 * 改了几何整理的代码后点“重算”就能比，不用再花钱调接口。没有标准答案的图只画叠加图，不打分。
 * window.evalRuns 里是每张图读到的内容和得分，方便拷出来存档。
 */
import { findSettings } from "../src/llm/providers";
import { detectInImage, draftFromReading, prepareImages, readPlan, type Draft, type Reading } from "../src/llm/recognize";
import type { Detection } from "../src/model/raster";
import { scorePlan, type PlanScore } from "../src/model/evaluate";
import { parseHouse, type House, type Vec2, type Wall } from "../src/model/schema";
import { pointInPolygon } from "../src/model/geometry";

/**
 * check：真实户型图的简易答案（像素坐标）。scale 是从图上尺寸链量出来的真实比例（像素/米，横、纵）；
 * rooms 是房间名字所在的点和类型，看识别出的、盖住这个点的房间类型对不对（客厅、餐厅算一类）。
 * 有 check.scale 时，和完整标准答案比几何之前，先把答案换到识别出的比例上：几何（墙的位置）和比例分开算，免得比例差 3% 把墙全算成错的。
 */
interface Check { scale: [number, number]; rooms?: [string, string, number, number][] }
interface Case { name: string; note?: string; image: string; crop: [number, number, number, number] | null; truth?: string; check?: Check }
interface CheckResult { scaleErr: [number, number]; rooms: { truth: number; covered: number; sameType: number; wrong: string[] } }
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const runs: Record<string, { reading: Reading; det?: Detection; draft?: Draft; score?: PlanScore; check?: CheckResult; problems?: string[]; scaleFrom?: string; error?: string }> = {};
Object.assign(window, { evalRuns: runs });

const s = findSettings(x => !!x.visionModel);
$("#key").textContent = s ? `识图用：${s.provider} · ${s.visionModel}（Key 已填）` : "没有填过 Key 的识图模型：先在主页的“大模型”面板里填（不填也能用存档重算）。";

const cases: Case[] = await (await fetch("/local/eval/cases.json")).json();

function svgOf(truth: House, walls: Wall[], offset: Vec2) {
  const all = [...truth.walls.flatMap(w => [w.a, w.b]), ...walls.flatMap(w => [w.a, w.b]).map(p => [p[0] + offset[0], p[1] + offset[1]] as Vec2)];
  const x0 = Math.min(...all.map(p => p[0])) - 0.5, z0 = Math.min(...all.map(p => p[1])) - 0.5;
  const x1 = Math.max(...all.map(p => p[0])) + 0.5, z1 = Math.max(...all.map(p => p[1])) + 0.5;
  const k = 40, line = (w: Wall, o: Vec2, color: string, width: number) =>
    `<line x1="${(w.a[0] + o[0] - x0) * k}" y1="${(w.a[1] + o[1] - z0) * k}" x2="${(w.b[0] + o[0] - x0) * k}" y2="${(w.b[1] + o[1] - z0) * k}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
  return `<svg width="${(x1 - x0) * k}" height="${(z1 - z0) * k}">${truth.walls.map(w => line(w, [0, 0], "#bbb", 8)).join("")}${walls.map(w => line(w, offset, "#2E4A6E", 3)).join("")}</svg>`;
}

const OPENING_COLOR: Record<string, string> = { door: "#d22", entry: "#c0c", sliding: "#f80", window: "#0aa", opening: "#2a2" };

/** 把识别结果画回原图上：墙（带编号）、门窗（按类型上色）、房间（虚线 + 名字），用来人工检查和改标准答案 */
async function overlay(c: Case, d: Draft): Promise<HTMLCanvasElement> {
  const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = c.image; });
  const [x0, y0, x1, y1] = c.crop ?? [0, 0, img.naturalWidth, img.naturalHeight];
  const k = Math.min(1, 1000 / (x1 - x0)), cv = document.createElement("canvas");
  cv.width = Math.round((x1 - x0) * k); cv.height = Math.round((y1 - y0) * k);
  const g = cv.getContext("2d")!, sx = d.background.pxPerM, sz = d.background.pxPerMz ?? sx;
  const P = (p: Vec2): [number, number] => [(p[0] * sx - x0) * k, (p[1] * sz - y0) * k];
  g.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, cv.width, cv.height);
  g.fillStyle = "rgba(255,255,255,0.55)"; g.fillRect(0, 0, cv.width, cv.height);
  g.font = "11px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  for (const r of d.rooms) {
    g.setLineDash([5, 4]); g.strokeStyle = "#777"; g.lineWidth = 1; g.beginPath();
    r.polygon.forEach((p, i) => { const q = P(p); if (i) g.lineTo(...q); else g.moveTo(...q); });
    g.closePath(); g.stroke(); g.setLineDash([]);
    const cx = r.polygon.reduce((a, p) => a + p[0], 0) / r.polygon.length, cz = r.polygon.reduce((a, p) => a + p[1], 0) / r.polygon.length;
    g.fillStyle = "#333"; g.font = "bold 12px sans-serif"; g.fillText(`${r.name}(${r.type})`, ...P([cx, cz]));
  }
  d.walls.forEach((w, i) => {
    const [ax, ay] = P(w.a), [bx, by] = P(w.b), L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
    g.strokeStyle = "rgba(30,60,140,0.55)"; g.lineWidth = Math.max(2, w.thickness * sx * k); g.lineCap = "butt";
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    for (const o of w.openings) {
      const t0 = o.offset / L, t1 = (o.offset + o.width) / L;
      g.strokeStyle = OPENING_COLOR[o.type] ?? "#000"; g.lineWidth = Math.max(3, w.thickness * sx * k + 2);
      g.beginPath(); g.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0); g.lineTo(ax + (bx - ax) * t1, ay + (by - ay) * t1); g.stroke();
    }
    g.fillStyle = "#fff"; g.fillRect((ax + bx) / 2 - 8, (ay + by) / 2 - 6, 16, 12);
    g.fillStyle = "#123"; g.font = "10px sans-serif"; g.fillText(String(i), (ax + bx) / 2, (ay + by) / 2);
  });
  return cv;
}

/** 标准答案按比例缩放（fx、fz 是横、纵的倍数） */
function rescale(h: House, fx: number, fz: number): House {
  const P = (p: Vec2): Vec2 => [p[0] * fx, p[1] * fz];
  return {
    ...h,
    walls: h.walls.map(w => {
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1, f = (Math.abs(w.b[0] - w.a[0]) * fx + Math.abs(w.b[1] - w.a[1]) * fz) / L;
      return { ...w, a: P(w.a), b: P(w.b), thickness: w.thickness * (fx + fz) / 2, openings: w.openings.map(o => ({ ...o, offset: o.offset * f, width: o.width * f })) };
    }),
    rooms: h.rooms.map(r => ({ ...r, polygon: r.polygon.map(P) })),
  };
}

const SAME: Record<string, string> = { dining: "living" };
function checkOf(c: Case, d: Draft): CheckResult | undefined {
  if (!c.check) return;
  const sx = d.background.pxPerM, sz = d.background.pxPerMz ?? sx;
  const rooms = { truth: 0, covered: 0, sameType: 0, wrong: [] as string[] };
  for (const [name, type, x, y] of c.check.rooms ?? []) {
    rooms.truth++;
    const r = d.rooms.find(r => pointInPolygon([x / sx, y / sz], r.polygon));
    if (!r) { rooms.wrong.push(`${name}：没有房间`); continue; }
    rooms.covered++;
    if ((SAME[r.type] ?? r.type) === (SAME[type] ?? type)) rooms.sameType++;
    else rooms.wrong.push(`${name}：认成 ${r.name}（${r.type}）`);
  }
  return { scaleErr: [sx / c.check.scale[0] - 1, sz / c.check.scale[1] - 1], rooms };
}

async function readingOf(c: Case): Promise<Reading | null> {
  const raw = localStorage.getItem("eval:reading:" + c.name);
  if (raw) return JSON.parse(raw);
  const r = await fetch(`/local/eval/runs/${encodeURIComponent(c.name)}.reading.json`);
  return r.ok && (r.headers.get("content-type") ?? "").includes("json") ? r.json() : null;
}

async function show(c: Case) {
  const r = runs[c.name]; if (!r) return;
  // 像素检测不花钱，每次重算都重新做（改了 raster.ts 之后点“重算”就能看到效果）
  const blob = await (await fetch(c.image)).blob();
  r.det = await detectInImage(blob, c.crop);
  // 用 import 读标准答案：同一个 json 被页面 import 过之后，开发服务器对它返回的是转换过的 JS，fetch 读不成 JSON
  const truth = c.truth ? parseHouse((await import(/* @vite-ignore */ c.truth)).default) : null;
  const box = document.getElementById("c-" + c.name) ?? Object.assign(document.createElement("div"), { id: "c-" + c.name, className: "case" });
  $("#out").appendChild(box);
  let d: Draft;
  try { d = draftFromReading(r.reading, r.det, null, truth?.height ?? 2.75); }
  catch (e) { r.error = (e as Error).message; box.innerHTML = `<h3>${c.name}</h3><p style="color:#b00">${r.error}</p>`; return; }
  const ck = checkOf(c, d);
  // 有量出来的真实比例：答案先换到识别出的比例上再比几何（比例误差单独看 ck.scaleErr）
  const geomTruth = truth && c.check ? rescale(truth, c.check.scale[0] / d.background.pxPerM, c.check.scale[1] / (d.background.pxPerMz ?? d.background.pxPerM)) : truth;
  const sc = geomTruth ? scorePlan(d, geomTruth) : undefined;
  Object.assign(r, { draft: d, score: sc, check: ck, problems: d.problems, scaleFrom: d.scaleFrom });
  const pct = (a: number, b: number) => b ? `${a}/${b}（${Math.round(a / b * 100)}%）` : "-";
  const ckRows = ck ? `
    <tr><td>比例误差（横、纵）</td><td>${ck.scaleErr.map(e => (e * 100).toFixed(1) + "%").join("、")}</td></tr>
    <tr><td>房间类型对</td><td>${pct(ck.rooms.sameType, ck.rooms.truth)}${ck.rooms.wrong.length ? "：" + ck.rooms.wrong.join("；") : ""}</td></tr>` : "";
  const rows = ckRows + (sc ? `
    <tr><td>墙：10 cm 内</td><td>${pct(sc.walls.within10, sc.walls.truth)}</td></tr>
    <tr><td>墙：30 cm 内</td><td>${pct(sc.walls.within30, sc.walls.truth)}</td></tr>
    <tr><td>多出来的墙</td><td>${sc.walls.extra} / 识别出 ${sc.walls.found}</td></tr>
    <tr><td>门窗：找到</td><td>${pct(sc.openings.found, sc.openings.truth)}，类型对 ${sc.openings.sameType}，多出 ${sc.openings.extra}</td></tr>
    <tr><td>房间：找到</td><td>${pct(sc.rooms.found, sc.rooms.truth)}，类型对 ${sc.rooms.sameType}，多出 ${sc.rooms.extra}</td></tr>` : `<tr><td>完整标准答案</td><td>没有</td></tr>`);
  box.innerHTML = `<h3>${c.name}${c.note ? "：" + c.note : ""}</h3>
    <table><tr><th>项目</th><th>结果</th></tr>${rows}
    <tr><td>比例、墙</td><td>${d.scaleFrom}（横 ${d.background.pxPerM.toFixed(2)}、纵 ${(d.background.pxPerMz ?? 0).toFixed(2)} 像素/米），墙来自 ${d.wallsFrom}；像素找到墙 ${r.det.walls.length}、房间 ${r.det.rooms.length}、洞口 ${r.det.gaps.length}</td></tr>
    <tr><td>识别出</td><td>墙 ${d.walls.length}、门窗 ${d.walls.reduce((n, w) => n + w.openings.length, 0)}、房间 ${d.rooms.length}（${d.rooms.map(x => x.name).join("、")}）</td></tr>
    <tr><td>耗时</td><td>${(r.reading.ms / 1000).toFixed(1)} 秒（两次接口调用同时发）</td></tr></table>
    <p>问题：${d.problems.length ? d.problems.join("；") : "无"}</p>
    ${truth && sc ? svgOf(truth, d.walls, sc.offset) : ""}
    <pre>${JSON.stringify(r.reading.chains.map(ch => `${ch.dir} ${ch.mm.join(" ")}${ch.total ? " 总 " + ch.total : ""}`), null, 1)}</pre>`;
  const cv = await overlay(c, d);
  cv.className = "overlay"; cv.dataset.case = c.name;
  box.appendChild(cv);
}


/** 汇总表：每张图一行 */
function summary() {
  const pc = (a: number, b: number) => b ? `${a}/${b}` : "-";
  const rows = cases.filter(c => runs[c.name]).map(c => {
    const r = runs[c.name], ck = r.check, sc = r.score;
    if (r.error) return `<tr><td>${c.name}</td><td colspan="7" style="text-align:left;color:#b00">${r.error}</td></tr>`;
    return `<tr><td>${c.name}</td><td>${r.scaleFrom ?? ""}</td><td>${ck ? ck.scaleErr.map(e => (e * 100).toFixed(1) + "%").join(" / ") : "-"}</td>
      <td>${ck ? pc(ck.rooms.sameType, ck.rooms.truth) : "-"}</td><td>${sc ? pc(sc.walls.within10, sc.walls.truth) + "、" + pc(sc.walls.within30, sc.walls.truth) : "-"}</td>
      <td>${sc ? sc.walls.extra : "-"}</td><td>${sc ? pc(sc.openings.found, sc.openings.truth) + "（类型对 " + sc.openings.sameType + "，多 " + sc.openings.extra + "）" : "-"}</td>
      <td>${sc ? pc(sc.rooms.found, sc.rooms.truth) : "-"}</td></tr>`;
  });
  $("#sum").innerHTML = `<table><tr><th>图</th><th>比例来自</th><th>比例误差 横/纵</th><th>房间类型对</th><th>墙 10/30 cm 内</th><th>多出的墙</th><th>门窗找到</th><th>房间重合≥0.5</th></tr>${rows.join("")}</table>`;
}

$("#run").addEventListener("click", async () => {
  if (!s) return;
  const only = new URLSearchParams(location.search).get("only")?.split(",");
  for (const c of cases.filter(c => !only || only.includes(c.name))) {
    $("#status").textContent = `识别 ${c.name}……`;
    try {
      const blob = await (await fetch(c.image)).blob();
      const det = await detectInImage(blob, c.crop);
      const { full, unit, marks } = await prepareImages(blob, c.crop, det);
      const reading = await readPlan(s, full, unit, { marks });
      runs[c.name] = { reading };
      localStorage.setItem("eval:reading:" + c.name, JSON.stringify(reading));
      await show(c);
      // 发给模型的那张（画了编号），方便查模型为什么认错
      document.getElementById("c-" + c.name)?.insertAdjacentHTML("beforeend", `<p>发给模型认房间的图：</p><img class="sent" src="${unit.url}" style="max-width:640px">`);
    } catch (e) { $("#out").insertAdjacentHTML("beforeend", `<p style="color:#b00">${c.name}：${(e as Error).message}</p>`); }
  }
  summary();
  $("#status").textContent = "完成";
});
$("#rescore").addEventListener("click", async () => {
  for (const c of cases) {
    const reading = await readingOf(c);
    if (reading) { runs[c.name] = { reading }; await show(c); }
  }
  summary();
  $("#status").textContent = "已重算";
});
