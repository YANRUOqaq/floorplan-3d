/**
 * 二维描图编辑器（SVG）。
 *
 * 用法：上传户型图当底图 → 标定比例（点图上两点，输入实际长度）→ 画墙 → 在墙上点出门窗 → 画房间 → 放家具。
 * 所有改动都通过 store 提交，所以能撤销；拖动过程中只改一份草稿（preview），松手时才提交，一次拖动算一步。
 *
 * 坐标：世界坐标单位米（x 向右、z 向下），屏幕坐标 = 平移 + 缩放 × 世界坐标。
 * 每次重画都把世界坐标换成屏幕坐标再画，这样线宽、文字大小不随缩放变化。
 */
import type { House, Item, Opening, Vec2, Wall } from "../model/schema";
import { OPENING_LABEL, OPENING_TYPES, roomDefaults } from "../model/schema";
import { CATALOG, CATALOG_BY_TYPE } from "../model/catalog";
import { distToSegment, itemFootprint, labelPoint, pointInPolygon, polygonArea, roomAt, wallFrame, wallPoint, houseBBox } from "../model/geometry";
import type { App } from "../ui/app";
import { esc, toast, uid } from "../ui/dom";
import { clearBg, imageSize, loadBg, saveBg } from "./bg";
import { nearestWall, placeOnWall, snap, snapTargets, type SnapResult } from "./snap";
import { detectInImage, draftFromReading, prepareImages, readPlan, type Draft, type Reading } from "../llm/recognize";
import type { Detection } from "../model/raster";
import { applyDraft } from "../model/draft";
import { findSettings } from "../llm/providers";

export type Tool = "select" | "wall" | "opening" | "room" | "item" | "calibrate" | "recog";
type OpeningType = (typeof OPENING_TYPES)[number];

/** 新建门窗的默认尺寸（米）：宽、下沿、上沿 */
const OPENING_DEFAULT: Record<OpeningType, { width: number; bottom: number; top: number; panels?: number }> = {
  door: { width: 0.9, bottom: 0, top: 2.05 },
  entry: { width: 1.0, bottom: 0, top: 2.1 },
  sliding: { width: 1.8, bottom: 0, top: 2.2, panels: 2 },
  window: { width: 1.5, bottom: 0.9, top: 2.3 },
  opening: { width: 0.9, bottom: 0, top: 2.2 },
};
const PX_TOL = 10;   // 吸附和点选的屏幕容差

type Drag =
  | { kind: "pan"; sx: number; sy: number; tx: number; ty: number }
  | { kind: "item"; id: string; dx: number; dz: number }
  | { kind: "opening"; wall: string; id: string; du: number }
  | { kind: "wallEnd"; at: Vec2 }
  | { kind: "wall"; id: string; start: Vec2; a: Vec2; b: Vec2 }
  | { kind: "vertex"; at: Vec2 }
  | { kind: "room-rect"; start: Vec2; sx: number; sy: number }
  | { kind: "recog-rect"; start: Vec2 };

export class Editor {
  private svg: SVGSVGElement;
  private bar: HTMLElement;
  private calibBox: HTMLElement;
  private view = { s: 50, tx: 40, ty: 40 };
  tool: Tool = "select";
  private openingType: OpeningType = "door";
  private itemType = "bed";
  private thickness = 0.2;
  /** 正在画的墙链或房间多边形 */
  private draft: Vec2[] = [];
  private cursor: SnapResult | null = null;
  private rawCursor: Vec2 | null = null;
  private drag: Drag | null = null;
  private preview: House | null = null;
  private moved = false;
  private calib: Vec2[] = [];
  private bg: { url: string; w: number; h: number } | null = null;
  private bgHidden = false;
  private fitted = false;
  /** 上次识别读到的内容：改了尺寸数字可以不调接口重算 */
  private reading: Reading | null = null;
  /** 上次识别时从像素里找到的墙和房间（不花钱，和 reading 一起重算） */
  private detection: Detection | null = null;
  /** 正在识别：按 Esc 停止 */
  private busy: AbortController | null = null;

  constructor(private root: HTMLElement, private app: App) {
    root.innerHTML = `
      <div class="ed-bar" role="toolbar" aria-label="编辑工具">
        <div class="seg" role="group" aria-label="工具">
          <button type="button" data-tool="select" title="选择、拖动（V）">选择</button>
          <button type="button" data-tool="wall" title="画墙：逐点单击，双击或按 Esc 结束（W）">画墙</button>
          <button type="button" data-tool="opening" title="在墙上单击放门窗（D）">门窗</button>
          <button type="button" data-tool="room" title="拖一个矩形，或逐点单击围出多边形（R）">房间</button>
          <button type="button" data-tool="item" title="单击放家具（F）">家具</button>
        </div>
        <span class="ed-sep"></span>
        <button type="button" class="btn small" id="ed-upload">上传户型图</button>
        <span class="ed-bgtools" id="ed-bgtools" hidden>
          <button type="button" class="btn small" data-tool="calibrate" id="ed-calib" title="在底图上点两个点，输入它们之间的实际长度">标定比例</button>
          <label class="ed-opt ed-bgopt">底图<input type="range" id="ed-opacity" min="0" max="1" step="0.05"></label>
          <button type="button" class="btn small" id="ed-bgtoggle">隐藏底图</button>
          <button type="button" class="btn small danger" id="ed-bgdel" title="从浏览器里删掉这张底图">删除底图</button>
          <button type="button" class="btn small" id="ed-recog" title="在户型图上框出你家那一户，让识图模型识别出墙、门窗和房间">识别户型图</button>
        </span>
        <button type="button" class="btn small" id="ed-fit" title="缩放到能看到全部">适应窗口</button>
        <input type="file" id="ed-file" accept="image/*" hidden>
      </div>
      <div class="ed-canvas"><svg id="ed-svg" tabindex="0" aria-label="户型平面图编辑区"></svg>
        <!-- 提示、工具选项、标定输入浮在画布上：放在画布上方会把画布往下挤，换工具时图会跳（2026-11-25 实测在 1440 宽时差一行） -->
        <div class="ed-float">
          <div class="ed-hint" id="ed-hint"></div>
          <label class="ed-opt" data-for="wall">墙厚
            <select id="ed-thick"><option value="0.24">24 cm</option><option value="0.2" selected>20 cm</option><option value="0.12">12 cm</option><option value="0.1">10 cm</option></select></label>
          <label class="ed-opt" data-for="opening">类型
            <select id="ed-opening">${OPENING_TYPES.map(t => `<option value="${t}">${OPENING_LABEL[t]}</option>`).join("")}</select></label>
          <label class="ed-opt" data-for="item">家具
            <select id="ed-item">${groupedCatalog()}</select></label>
          <div class="ed-calib" id="ed-calibbox" hidden></div>
          <button type="button" class="btn small" id="ed-whole" hidden>整张图就是一户</button>
          <div class="ed-review" id="ed-review" hidden></div>
        </div>
      </div>`;
    this.svg = root.querySelector("#ed-svg") as SVGSVGElement;
    this.bar = root.querySelector(".ed-bar") as HTMLElement;
    this.calibBox = root.querySelector("#ed-calibbox") as HTMLElement;
    this.bindUI();
    this.bindPointer();
    new ResizeObserver(() => { if (!this.fitted && this.svg.clientWidth) this.fit(); this.render(); }).observe(this.svg);
    this.reloadBg();
    this.setTool("select");
  }

  private get house(): House { return this.preview ?? this.app.store.house; }

  /* ---------- 坐标换算 ---------- */
  private S = (p: Vec2): [number, number] => [this.view.tx + p[0] * this.view.s, this.view.ty + p[1] * this.view.s];
  private W(sx: number, sy: number): Vec2 { return [(sx - this.view.tx) / this.view.s, (sy - this.view.ty) / this.view.s]; }
  private evWorld(e: PointerEvent | MouseEvent | WheelEvent): Vec2 {
    const r = this.svg.getBoundingClientRect();
    return this.W(e.clientX - r.left, e.clientY - r.top);
  }
  private get tol() { return PX_TOL / this.view.s; }

  /** 缩放到能看见全部墙、房间和底图 */
  fit() {
    const w = this.svg.clientWidth, h = this.svg.clientHeight;
    if (!w || !h) return;
    const hs = this.house;
    let bb = hs.walls.length || hs.rooms.length ? houseBBox(hs) : null;
    const bgb = this.bgWorldRect();
    if (bgb && (!bb || !this.bgHidden)) bb = bb ? { x0: Math.min(bb.x0, bgb.x0), x1: Math.max(bb.x1, bgb.x1), z0: Math.min(bb.z0, bgb.z0), z1: Math.max(bb.z1, bgb.z1) } : bgb;
    bb ??= { x0: 0, x1: 10, z0: 0, z1: 8 };
    const pad = 40;
    const s = Math.min((w - 2 * pad) / Math.max(bb.x1 - bb.x0, 1), (h - 2 * pad) / Math.max(bb.z1 - bb.z0, 1));
    this.view = { s, tx: (w - s * (bb.x0 + bb.x1)) / 2, ty: (h - s * (bb.z0 + bb.z1)) / 2 };
    this.fitted = true;
    this.render();
  }
  private bgWorldRect() {
    const b = this.house.background; if (!b || !this.bg) return null;
    const sz = b.pxPerMz ?? b.pxPerM;
    return { x0: -b.origin[0] / b.pxPerM, z0: -b.origin[1] / sz, x1: (this.bg.w - b.origin[0]) / b.pxPerM, z1: (this.bg.h - b.origin[1]) / sz };
  }

  /* ---------- 工具栏 ---------- */
  setTool(t: Tool) {
    if (t === "calibrate" && !this.bg) { toast("先上传户型图，再标定比例。", true); return; }
    this.tool = t; this.draft = []; this.calib = []; this.calibBox.hidden = true;
    this.bar.querySelectorAll<HTMLElement>("[data-tool]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
    this.root.querySelectorAll<HTMLElement>(".ed-opt[data-for]").forEach(l => { l.hidden = l.dataset.for !== t; });
    (this.root.querySelector("#ed-whole") as HTMLElement).hidden = t !== "recog";
    this.svg.style.cursor = t === "select" ? "default" : "crosshair";
    this.render();
  }
  private hint(): string {
    switch (this.tool) {
      case "select": return "点选墙、门窗、房间、家具，拖动可以移动；拖墙的端点改长度。Delete 删除，家具按 R 转 90°。拖空白处平移，滚轮缩放。";
      case "wall": return this.draft.length ? "继续单击加下一段墙；双击、右键或 Esc 结束。按住 Shift 不吸附水平竖直。" : "单击墙的起点。沿着户型图上墙的中线描。";
      case "opening": return `单击墙放一个${OPENING_LABEL[this.openingType]}，放好后在右侧面板改宽度和高度。`;
      case "room": return this.draft.length ? "继续单击房间的角；点回第一个点或双击闭合。" : "按住拖一个矩形；不是矩形的房间就逐点单击围出来。沿墙中线描。";
      case "item": return `单击放一个${CATALOG_BY_TYPE[this.itemType]?.nameZh ?? ""}，放好后可以拖动、按 R 旋转。`;
      case "calibrate": return this.calib.length === 0 ? "在户型图上点一个标注了尺寸的线段的起点（比如轴线标注 3750 的一端）。" : "再点这段的终点。";
      case "recog": return "按住拖一个框，框住你家那一户（连阳台），别框进邻居家；松手就开始识别。整张图只有你家一户就点下面的“整张图就是一户”。Esc 取消。";
    }
  }
  private bindUI() {
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    this.bar.addEventListener("click", e => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tool]");
      if (t) this.setTool(t.dataset.tool as Tool);
    });
    q<HTMLSelectElement>("#ed-thick").addEventListener("change", e => { this.thickness = +(e.target as HTMLSelectElement).value; });
    q<HTMLSelectElement>("#ed-opening").addEventListener("change", e => { this.openingType = (e.target as HTMLSelectElement).value as OpeningType; this.render(); });
    q<HTMLSelectElement>("#ed-item").addEventListener("change", e => { this.itemType = (e.target as HTMLSelectElement).value; this.render(); });
    q<HTMLSelectElement>("#ed-item").value = this.itemType;
    const file = q<HTMLInputElement>("#ed-file");
    q("#ed-upload").addEventListener("click", () => {
      if (this.bg && this.app.store.house.background && !confirm("换一张户型图？现在这张会被替换，不能撤销。")) return;
      this.upload();
    });
    file.addEventListener("change", async () => {
      const f = file.files?.[0]; file.value = ""; if (!f) return;
      try { await this.setBackground(f); } catch (err) { toast((err as Error).message, true); }
    });
    q<HTMLInputElement>("#ed-opacity").addEventListener("input", e => {
      const v = +(e.target as HTMLInputElement).value;
      const img = this.svg.querySelector<SVGImageElement>("image"); if (img) img.setAttribute("opacity", String(v));
    });
    q<HTMLInputElement>("#ed-opacity").addEventListener("change", e => {
      const v = +(e.target as HTMLInputElement).value;
      if (this.app.store.house.background) this.app.store.commit("底图透明度", d => { d.background!.opacity = v; });
    });
    q("#ed-bgtoggle").addEventListener("click", () => { this.bgHidden = !this.bgHidden; this.render(); });
    q("#ed-fit").addEventListener("click", () => this.fit());
    q("#ed-recog").addEventListener("click", () => this.startRecognize());
    q("#ed-whole").addEventListener("click", () => this.recognizeBox(null));
    // 识别结果浮层：改尺寸数字后重算、下一步布置家具、关闭
    q("#ed-review").addEventListener("click", e => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-rv]")?.dataset.rv;
      if (act === "close") this.showReview("");
      else if (act === "furnish") { this.showReview(""); this.app.furnish(); }
      else if (act === "redo" && this.reading) {
        for (const inp of q("#ed-review").querySelectorAll<HTMLInputElement>("[data-chain]")) {
          const ch = this.reading.chains[+inp.dataset.chain!], nums = inp.value.trim().split(/[\s,，、]+/).filter(Boolean);
          if (nums.length !== ch.mm.length) { toast(`“${inp.value}”是 ${nums.length} 个数，原来是 ${ch.mm.length} 段；只改数字，不要增减段数。`, true); return; }
          ch.mm = nums.map(v => Number(v) > 0 ? Number(v) : null);
        }
        this.applyReading();
      }
    });
    // 底图图片在浏览器里只存一张，删了、换了都撤销不回来（撤销只恢复标定），所以先确认
    q("#ed-bgdel").addEventListener("click", () => { if (this.bg && confirm("删除这张户型图？删除后不能撤销，要用得重新上传。")) this.removeBackground(); });
  }

  /* ---------- 底图 ---------- */
  /** 打开选图片的对话框（“从户型图生成”也走这里） */
  upload() { (this.root.querySelector("#ed-file") as HTMLInputElement).click(); }
  async setBackground(f: Blob & { name?: string }) {
    const { w, h } = await imageSize(f);
    await saveBg({ blob: f, w, h, name: f.name ?? "户型图" });
    await this.reloadBg();
    // 先按“图宽约 12 米”粗略定比例，提示用户标定
    this.app.store.commit("上传底图", d => { d.background = { pxPerM: w / 12, origin: [0, 0], opacity: 0.5 }; });
    this.bgHidden = false;
    this.fit();
    // 填过能看图的模型的 Key：直接框选识别（比例从图上的尺寸算）；没填就手动标定、描图
    if (findSettings(s => !!s.visionModel)) {
      this.setTool("recog");
      toast("户型图已载入。拖一个框框住你家那一户，自动识别墙、门窗和房间；整张图就是你家就点“整张图就是一户”。", false, 7000);
    } else {
      this.setTool("calibrate");
      toast("户型图已载入。想自动识别，先在右侧“大模型”面板填通义千问的 Key；自己描的话，先标定比例：在图上点一段标了尺寸的线的两端。", false, 8000);
    }
  }
  async reloadBg() {
    try {
      const b = await loadBg();
      if (this.bg) URL.revokeObjectURL(this.bg.url);
      this.bg = b ? { url: URL.createObjectURL(b.blob), w: b.w, h: b.h } : null;
    } catch { this.bg = null; }
    this.render();
  }
  async removeBackground() {
    await clearBg(); await this.reloadBg();
    if (this.app.store.house.background) this.app.store.commit("删除底图", d => { delete d.background; });
  }
  /* ---------- 识别户型图 ---------- */
  /** 先检查能不能识别，能的话切到“框选”工具，让用户框出自己那一户（整张图只有一户可以直接点“整张图就是一户”） */
  startRecognize() {
    if (!this.bg || !this.app.store.house.background) { toast("先上传户型图。", true); return; }
    if (!findSettings(s => !!s.visionModel)) { toast("识别要用能看图的模型：先在右侧“大模型”面板选通义千问（或其他有识图模型的厂商），填上 Key。", true); this.app.showSide("ai"); return; }
    this.setTool("recog");
  }
  /**
   * 识别：本地先从像素找墙、洞口、房间，再让模型读尺寸、按编号认房间门窗（两次调用同时发，见 llm/recognize.ts），
   * 最后算比例、合成墙和房间（model/scale.ts、model/fuse.ts）。比例也一起定好，不用再手动标定。
   * box 是框的两个角（世界坐标），null 表示整张图。
   */
  async recognizeBox(box: [Vec2, Vec2] | null) {
    const bgInfo = this.app.store.house.background, img = this.bg;
    if (!img || !bgInfo) return;
    let crop: [number, number, number, number] | null = null;
    if (box) {
      const [p0, p1] = box.map(p => this.worldToImg(p));
      const x0 = Math.max(0, Math.floor(Math.min(p0[0], p1[0]))), y0 = Math.max(0, Math.floor(Math.min(p0[1], p1[1])));
      const x1 = Math.min(img.w, Math.ceil(Math.max(p0[0], p1[0]))), y1 = Math.min(img.h, Math.ceil(Math.max(p0[1], p1[1])));
      if (x1 - x0 < 50 || y1 - y0 < 50) { toast("框太小了，或者没框在户型图上，再框一次。", true); this.setTool("recog"); return; }
      crop = [x0, y0, x1, y1];
    }
    const s = findSettings(s => !!s.visionModel);
    if (!s) { this.startRecognize(); return; }
    this.setTool("select");
    this.busy = new AbortController();
    const t0 = Date.now();
    const tick = () => this.showReview(`<p>识别中……已等 ${Math.round((Date.now() - t0) / 1000)} 秒（一般一两分钟）。按 Esc 可以停止。</p>`);
    tick();
    const timer = setInterval(tick, 1000);
    try {
      const rec = await loadBg();
      // 先在本地从像素找墙和房间（不花钱，一两秒），把找到的房间、洞口编上号画在图上，再让模型读数字、按编号认房间（花钱，一两分钟）
      const det = await detectInImage(rec!.blob, crop);
      const { full, unit, marks } = await prepareImages(rec!.blob, crop, det);
      const reading = await readPlan(s, full, unit, { marks, signal: this.busy.signal });
      this.reading = reading; this.detection = det;
      this.applyReading();
    } catch (e) {
      const err = e as Error;
      this.showReview(err.name === "AbortError" ? "" : `<p class="err">${esc(err.message)}</p><div class="row"><button type="button" class="btn small" data-rv="close">关闭</button></div>`);
    } finally { clearInterval(timer); this.busy = null; }
  }
  /** 把读到的内容（可能改过尺寸数字）整理成草稿，替换当前方案的墙和房间 */
  private applyReading() {
    const r = this.reading; if (!r) return;
    const h = this.app.store.house, b = h.background;
    let d: Draft;
    try { d = draftFromReading(r, this.detection, b && b.pxPerMz != null ? { pxPerM: b.pxPerM, pxPerMz: b.pxPerMz } : null, h.height); }
    catch (e) { this.showReview(`<p class="err">${esc((e as Error).message)}</p><div class="row"><button type="button" class="btn small" data-rv="close">关闭</button></div>`); return; }
    if (!d.walls.length) { this.showReview(`<p class="err">没识别出房间。可以把框收紧到你家那一户再试，或者手动描。</p><div class="row"><button type="button" class="btn small" data-rv="close">关闭</button></div>`); return; }
    this.app.store.replace(applyDraft(h, d), "识别户型图");
    this.fit();
    const doors = d.walls.reduce((n, w) => n + w.openings.length, 0);
    const from = { chains: "按图上的尺寸算的", overall: "按总尺寸对外墙算的", areas: "按房间面积估的", manual: "按你标定的" }[d.scaleFrom];
    const chains = r.chains.map((c, i) => `<label class="rv-chain">${c.dir === "h" ? "横" : "竖"}<input data-chain="${i}" value="${esc(c.mm.map(v => v ?? "?").join(" "))}"></label>`).join("");
    this.showReview(`
      <p><b>识别出 ${d.rooms.length} 个房间、${d.walls.length} 面墙、${doors} 个门窗</b>，比例${from}。这是草稿：对照底图看一遍，墙拖端点改，门窗不对可以删掉重放，房间名和类型在右侧改。</p>
      ${d.problems.length ? `<ul class="rv-problems">${d.problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      ${r.chains.length ? `<details><summary>读到的尺寸（数字读错了可以改，改完点“重算”）</summary><div class="rv-chains">${chains}</div><button type="button" class="btn small" data-rv="redo">重算</button></details>` : ""}
      <div class="row"><button type="button" class="btn small primary" data-rv="furnish">下一步：布置家具</button><button type="button" class="btn small" data-rv="close">关闭</button></div>`);
  }
  /** 识别进度和结果显示在画布左上角的浮层里 */
  private showReview(html: string) {
    const box = this.root.querySelector("#ed-review") as HTMLElement;
    box.hidden = !html; box.innerHTML = html;
  }
  /** 底图上的像素坐标 ↔ 世界坐标 */
  private worldToImg(p: Vec2): Vec2 { const b = this.house.background!; return [p[0] * b.pxPerM + b.origin[0], p[1] * (b.pxPerMz ?? b.pxPerM) + b.origin[1]]; }

  private finishCalibration(meters: number) {
    const b = this.app.store.house.background; if (!b || this.calib.length < 2) return;
    const [A, B] = this.calib.map(p => this.worldToImg(p));
    const dx = Math.abs(B[0] - A[0]), dy = Math.abs(B[1] - A[1]);
    if (Math.hypot(dx, dy) < 5 || !(meters > 0)) { toast("两个点太近或长度不对，重新点一次。", true); this.setTool("calibrate"); return; }
    // 横着量的只定横向比例，竖着量的只定纵向比例（照片拉伸时两者不同）；斜着量或第一次标定时两个方向一起定
    const first = b.pxPerMz == null;
    const dir = dx > dy * 4 ? "x" : dy > dx * 4 ? "z" : "both";
    let sx = b.pxPerM, sz = b.pxPerMz ?? b.pxPerM;
    if (dir === "x") { sx = dx / meters; if (first) sz = sx; }
    else if (dir === "z") { sz = dy / meters; if (first) sx = sz; }
    else sx = sz = Math.hypot(dx, dy) / meters;
    // 以第一个点为中心缩放：它的世界坐标保持不变，已经描好的墙不会跑偏
    const worldA = this.calib[0];
    this.app.store.commit("标定比例", d => { d.background = { ...b, pxPerM: sx, pxPerMz: sz, origin: [A[0] - worldA[0] * sx, A[1] - worldA[1] * sz] }; });
    const what = dir === "x" ? "横向" : dir === "z" ? "纵向" : "横竖";
    toast(`${what}比例已标定：1 米 = ${(dir === "z" ? sz : sx).toFixed(1)} 像素。` +
      (first && dir !== "both" ? `\n照片如果被拉伸过，再标一段${dir === "x" ? "竖" : "横"}着的尺寸，可以单独校准${dir === "x" ? "纵" : "横"}向。` : ""), false, 6000);
    this.fit();
    this.setTool("wall");
  }
  private showCalibForm() {
    const box = this.calibBox;
    box.innerHTML = `<label>这两点之间的实际长度 <input type="number" id="ed-calib-mm" min="100" step="10" placeholder="比如 3750"> mm</label>
      <button type="button" class="btn small primary" id="ed-calib-ok">确定</button><button type="button" class="btn small" id="ed-calib-cancel">重新点</button>`;
    box.hidden = false;
    const inp = box.querySelector<HTMLInputElement>("#ed-calib-mm")!;
    // 这里是在画布的 pointerdown 里调用的，紧接着浏览器处理 mousedown 时会把焦点给画布；
    // 等这次点击处理完再聚焦，用户点完第二个点就能直接输数字（2026-11-25 实测直接 focus 会被抢走）
    setTimeout(() => inp.focus(), 0);
    const ok = () => this.finishCalibration(+inp.value / 1000);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") ok(); });
    box.querySelector("#ed-calib-ok")!.addEventListener("click", ok);
    box.querySelector("#ed-calib-cancel")!.addEventListener("click", () => this.setTool("calibrate"));
  }

  /* ---------- 点选 ---------- */
  private hit(p: Vec2): string | null {
    const h = this.house, tol = this.tol;
    // 家具（上面的优先：后放的、离地高的先选中）
    for (let i = h.furniture.length - 1; i >= 0; i--) if (pointInPolygon(p, itemFootprint(h.furniture[i]))) return h.furniture[i].id;
    // 门窗
    for (const w of h.walls) for (const o of w.openings) {
      if (distToSegment(p, wallPoint(w, o.offset), wallPoint(w, o.offset + o.width)) < w.thickness / 2 + tol) return o.id;
    }
    for (const w of h.walls) if (distToSegment(p, w.a, w.b) < w.thickness / 2 + tol * 0.5) return w.id;
    // 房间：面积小的优先（飘窗、过道压在大房间上时）
    const rs = h.rooms.filter(r => pointInPolygon(p, r.polygon)).sort((a, b) => polygonArea(a.polygon) - polygonArea(b.polygon));
    return rs[0]?.id ?? null;
  }
  private find(id: string | null) {
    const h = this.house;
    if (!id) return null;
    const item = h.furniture.find(f => f.id === id); if (item) return { kind: "item" as const, item };
    for (const w of h.walls) { if (w.id === id) return { kind: "wall" as const, wall: w }; const o = w.openings.find(o => o.id === id); if (o) return { kind: "opening" as const, wall: w, opening: o }; }
    const room = h.rooms.find(r => r.id === id); if (room) return { kind: "room" as const, room };
    return null;
  }

  /* ---------- 指针 ---------- */
  private bindPointer() {
    const svg = this.svg;
    // 双击：两次点击间隔短，而且在屏幕上几乎是同一个位置（快速连点不同位置不算）
    let lastClick = { t: 0, x: 0, y: 0 };
    svg.addEventListener("contextmenu", e => { e.preventDefault(); this.endDraft(); });
    svg.addEventListener("wheel", e => {
      e.preventDefault();
      const r = svg.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      const k = Math.exp(-e.deltaY * 0.0015), s = Math.min(800, Math.max(5, this.view.s * k));
      const wpt = this.W(sx, sy);
      this.view = { s, tx: sx - wpt[0] * s, ty: sy - wpt[1] * s };
      this.render();
    }, { passive: false });
    svg.addEventListener("pointerdown", e => {
      svg.focus({ preventScroll: true });
      if (e.button === 2) return;
      try { svg.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      const p = this.evWorld(e);
      this.moved = false;
      if (e.button === 1 || (e.button === 0 && e.altKey)) { this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, tx: this.view.tx, ty: this.view.ty }; return; }
      const now = performance.now();
      const dbl = now - lastClick.t < 350 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 6;
      lastClick = { t: now, x: e.clientX, y: e.clientY };
      if (this.tool === "select") this.selectDown(p, e);
      else if (this.tool === "wall") this.wallClick(dbl, e.shiftKey);
      else if (this.tool === "room") this.roomDown(p, e, dbl);
      else if (this.tool === "opening") this.openingClick(p);
      else if (this.tool === "item") this.itemClick(p);
      else if (this.tool === "calibrate") this.calibClick(p);
      else if (this.tool === "recog") this.drag = { kind: "recog-rect", start: p };
    });
    svg.addEventListener("pointermove", e => {
      const p = this.evWorld(e);
      this.rawCursor = p;
      if (this.drag) { this.moved = true; this.dragMove(p, e); return; }
      if (this.tool === "wall" || this.tool === "room") this.cursor = snap(p, snapTargets(this.house), this.draft.at(-1) ?? null, this.tol, e.shiftKey);
      else this.cursor = null;
      if (this.tool !== "select") this.render();
      else this.svg.style.cursor = this.hit(p) ? "move" : "default";
    });
    svg.addEventListener("pointerup", e => this.dragEnd(e));
    svg.addEventListener("pointercancel", () => { this.drag = null; this.preview = null; this.render(); });
    svg.addEventListener("pointerleave", () => { this.rawCursor = null; if (this.tool !== "select") this.render(); });
    svg.addEventListener("keydown", e => this.onKey(e));
  }

  private selectDown(p: Vec2, e: PointerEvent) {
    const id = this.hit(p), sel = this.find(this.app.selected);
    // 已选中的墙：先看是不是点在端点上（拖端点改长度）
    const nearEnd = (q: Vec2) => Math.hypot(q[0] - p[0], q[1] - p[1]) < this.tol;
    if (sel?.kind === "wall") for (const q of [sel.wall.a, sel.wall.b]) if (nearEnd(q)) { this.startDrag({ kind: "wallEnd", at: [q[0], q[1]] }); return; }
    if (sel?.kind === "room") for (const q of sel.room.polygon) if (nearEnd(q)) { this.startDrag({ kind: "vertex", at: [q[0], q[1]] }); return; }
    if (id !== this.app.selected) this.app.select(id);
    const f = this.find(id);
    if (!f) { this.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, tx: this.view.tx, ty: this.view.ty }; return; }
    if (f.kind === "item" && !f.item.fixed) this.startDrag({ kind: "item", id: f.item.id, dx: f.item.pos[0] - p[0], dz: f.item.pos[1] - p[1] });
    else if (f.kind === "opening") {
      const { d } = wallFrame(f.wall), u = (p[0] - f.wall.a[0]) * d[0] + (p[1] - f.wall.a[1]) * d[1];
      this.startDrag({ kind: "opening", wall: f.wall.id, id: f.opening.id, du: f.opening.offset - u });
    } else if (f.kind === "wall") this.startDrag({ kind: "wall", id: f.wall.id, start: p, a: [...f.wall.a], b: [...f.wall.b] });
  }
  private startDrag(d: Drag) { this.drag = d; this.preview = structuredClone(this.app.store.house); }

  private dragMove(p: Vec2, e: PointerEvent) {
    const d = this.drag!, h = this.preview;
    if (d.kind === "pan") { this.view.tx = d.tx + e.clientX - d.sx; this.view.ty = d.ty + e.clientY - d.sy; this.render(); return; }
    if (d.kind === "room-rect") { this.cursor = snap(p, snapTargets(this.house), null, this.tol, e.shiftKey); this.render(); return; }
    if (d.kind === "recog-rect") { this.render(); return; }
    if (!h) return;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    if (d.kind === "item") {
      const it = h.furniture.find(f => f.id === d.id)!;
      it.pos = [r2(p[0] + d.dx), r2(p[1] + d.dz)];
      it.room = roomAt(h.rooms, it.pos)?.id;
    } else if (d.kind === "opening") {
      const w = h.walls.find(w => w.id === d.wall)!, o = w.openings.find(o => o.id === d.id)!;
      const { len, d: dir } = wallFrame(w), u = (p[0] - w.a[0]) * dir[0] + (p[1] - w.a[1]) * dir[1];
      o.offset = r2(Math.max(0, Math.min(len - o.width, u + d.du)));
    } else if (d.kind === "wallEnd" || d.kind === "vertex") {
      // 和这个点重合的所有墙端点、房间顶点一起动，相连的墙不会断开
      const from = d.at, fresh = structuredClone(this.app.store.house);
      const excl = new Set<Vec2>();
      fresh.walls.forEach(w => [w.a, w.b].forEach(q => { if (same(q, from)) excl.add(q); }));
      fresh.rooms.forEach(r => r.polygon.forEach(q => { if (same(q, from)) excl.add(q); }));
      const s = snap(p, snapTargets(fresh, excl), null, this.tol, e.shiftKey);
      this.cursor = s;
      for (const q of excl) { q[0] = s.p[0]; q[1] = s.p[1]; }
      this.preview = fresh;
    } else if (d.kind === "wall") {
      const dx = r2(p[0] - d.start[0]), dz = r2(p[1] - d.start[1]), fresh = structuredClone(this.app.store.house);
      const pts: Vec2[] = [];
      fresh.walls.forEach(w => [w.a, w.b].forEach(q => { if (same(q, d.a) || same(q, d.b)) pts.push(q); }));
      fresh.rooms.forEach(r => r.polygon.forEach(q => { if (same(q, d.a) || same(q, d.b)) pts.push(q); }));
      for (const q of pts) { q[0] = r2(q[0] + dx); q[1] = r2(q[1] + dz); }
      this.preview = fresh;
    }
    this.render();
  }
  private dragEnd(e: PointerEvent) {
    const d = this.drag; this.drag = null;
    if (!d) return;
    if (d.kind === "room-rect") {
      const end = this.cursor?.p ?? this.evWorld(e);
      if (this.moved && Math.abs(end[0] - d.start[0]) > 0.3 && Math.abs(end[1] - d.start[1]) > 0.3) {
        const [x0, x1] = [Math.min(d.start[0], end[0]), Math.max(d.start[0], end[0])], [z0, z1] = [Math.min(d.start[1], end[1]), Math.max(d.start[1], end[1])];
        this.addRoom([[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
      } else this.draft = [d.start];   // 没拖动：开始逐点画多边形
      this.render(); return;
    }
    if (d.kind === "recog-rect") {
      if (this.tool !== "recog") { this.render(); return; }   // 拖的过程中按了 Esc
      this.recognizeBox([d.start, this.evWorld(e)]); return;
    }
    const prev = this.preview; this.preview = null; this.cursor = null;
    if (prev && this.moved) {
      try { this.app.store.replace(prev, "拖动"); } catch (err) { toast((err as Error).message, true); this.render(); }
    } else this.render();
  }

  /* ---------- 画墙 ---------- */
  private wallClick(dbl: boolean, shift: boolean) {
    const s = this.cursor ?? (this.rawCursor ? snap(this.rawCursor, snapTargets(this.house), this.draft.at(-1) ?? null, this.tol, shift) : null);
    if (!s) return;
    const last = this.draft.at(-1);
    if (dbl && last && same(last, s.p)) { this.endDraft(); return; }
    if (last && Math.hypot(s.p[0] - last[0], s.p[1] - last[1]) < 0.05) { if (dbl) this.endDraft(); return; }
    if (last) {
      const a: Vec2 = [last[0], last[1]], b: Vec2 = [s.p[0], s.p[1]], t = this.thickness;
      this.app.store.commit("画墙", d => { d.walls.push({ id: uid("w", ids(d)), a, b, thickness: t, kind: "wall", openings: [] }); });
    }
    this.draft.push(s.p);
    if (dbl) this.endDraft();
    this.render();
  }
  private endDraft() { this.draft = []; this.render(); }

  /* ---------- 房间 ---------- */
  private roomDown(p: Vec2, e: PointerEvent, dbl: boolean) {
    const s = snap(p, snapTargets(this.house), this.draft.at(-1) ?? null, this.tol, e.shiftKey);
    if (!this.draft.length) { this.drag = { kind: "room-rect", start: s.p, sx: e.clientX, sy: e.clientY }; this.cursor = s; return; }
    const first = this.draft[0];
    if (this.draft.length >= 3 && (same(s.p, first) || dbl)) {
      this.addRoom(this.draft.slice()); this.draft = []; this.render(); return;
    }
    if (!same(s.p, this.draft.at(-1)!)) this.draft.push(s.p);
    this.render();
  }
  private addRoom(poly: Vec2[]) {
    if (polygonArea(poly) < 0.3) { toast("房间太小了。", true); return; }
    let newId = "";
    this.app.store.commit("画房间", d => {
      newId = uid("r", ids(d));
      d.rooms.push({ id: newId, name: `房间 ${d.rooms.length + 1}`, type: "other", polygon: poly.map(q => [q[0], q[1]] as Vec2), ...roomDefaults("other") });
    });
    this.app.select(newId);
    toast("房间已添加。在右侧面板里改名字和类型（类型决定默认地面和墙面）。");
  }

  /* ---------- 门窗 ---------- */
  private openingClick(p: Vec2) {
    const nw = nearestWall(this.house, p, this.tol);
    if (!nw) { toast("要点在墙上。", true); return; }
    const w = this.house.walls.find(w => w.id === nw.id)!;
    if (w.kind !== "wall") { toast("矮墙和栏板上不能开门窗。", true); return; }
    const def = OPENING_DEFAULT[this.openingType], { len } = wallFrame(w);
    const { offset, width } = placeOnWall(len, nw.u, def.width);
    const clash = w.openings.find(o => offset < o.offset + o.width && o.offset < offset + width);
    if (clash) { toast(`和已有的${OPENING_LABEL[clash.type]}重叠了。`, true); return; }
    let newId = "";
    const H = w.height ?? this.house.height;
    this.app.store.commit("放门窗", d => {
      newId = uid(this.openingType === "window" ? "win" : "d", ids(d));
      const o: Opening = { id: newId, type: this.openingType, offset, width, bottom: def.bottom, top: Math.min(def.top, H - 0.1) };
      if (this.openingType === "door" || this.openingType === "entry") { o.hinge = "a"; o.side = 1; }
      if (def.panels) o.panels = def.panels;
      d.walls.find(x => x.id === w.id)!.openings.push(o);
    });
    this.app.select(newId);
  }

  /* ---------- 家具 ---------- */
  private itemClick(p: Vec2) {
    const c = CATALOG_BY_TYPE[this.itemType];
    const pos: Vec2 = [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
    let newId = "";
    this.app.store.commit("放家具", d => {
      newId = uid(c.type.replace(/_.*/, "").slice(0, 6), ids(d));
      const it: Item = { id: newId, type: c.type, name: c.nameZh, room: roomAt(d.rooms, pos)?.id, pos, rot: 0, size: [...c.defaultSize] };
      if (c.mount === "ceiling") it.elevation = 1.6;
      d.furniture.push(it);
    });
    this.app.select(newId);
    this.setTool("select");
  }

  /* ---------- 标定 ---------- */
  private calibClick(p: Vec2) {
    if (this.calib.length >= 2) return;
    this.calib.push(p);
    if (this.calib.length === 2) this.showCalibForm();
    this.render();
  }

  /* ---------- 键盘 ---------- */
  private onKey(e: KeyboardEvent) {
    const sel = this.find(this.app.selected);
    if (e.key === "Escape" && this.busy) { this.busy.abort(); e.preventDefault(); return; }
    if (e.key === "Escape") { if (this.draft.length) this.endDraft(); else if (this.tool !== "select") this.setTool("select"); else this.app.select(null); e.preventDefault(); return; }
    if (e.key === "Enter" && this.draft.length) { if (this.tool === "room" && this.draft.length >= 3) { this.addRoom(this.draft.slice()); } this.endDraft(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); deleteById(this.app, this.app.selected!); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "r" && sel?.kind === "item" && !sel.item.fixed) { const id = sel.item.id; this.app.store.commit("旋转", d => { const it = d.furniture.find(f => f.id === id)!; it.rot = normRot(it.rot + (e.shiftKey ? -90 : 90)); }); return; }
    const toolKeys: Record<string, Tool> = { v: "select", w: "wall", d: "opening", r: "room", f: "item" };
    if (toolKeys[k]) this.setTool(toolKeys[k]);
  }

  /* ---------- 绘制 ---------- */
  render() {
    const svg = this.svg, h = this.house, S = this.S, s = this.view.s;
    // 标定、透明度、识别这些按钮只对底图有用，没有底图时不显示（点了也只会报“先上传户型图”）。
    // 底图图片只存一张、不跟方案走：新建的空方案没有底图标定，也不显示
    (this.root.querySelector("#ed-bgtools") as HTMLElement).hidden = !(this.bg && h.background);
    if (!svg.clientWidth) return;
    (this.root.querySelector("#ed-hint") as HTMLElement).textContent = this.hint();
    const sel = this.app.selected;
    const parts: string[] = [];
    const pts = (ps: Vec2[]) => ps.map(p => S(p).map(v => v.toFixed(1)).join(",")).join(" ");
    // 网格：每米一条
    const vb = { x0: this.W(0, 0)[0], z0: this.W(0, 0)[1], x1: this.W(svg.clientWidth, svg.clientHeight)[0], z1: this.W(svg.clientWidth, svg.clientHeight)[1] };
    if (s > 12) {
      let g = "";
      for (let x = Math.ceil(vb.x0); x <= vb.x1; x++) { const sx = S([x, 0])[0]; g += `M${sx.toFixed(1)} 0V${svg.clientHeight}`; }
      for (let z = Math.ceil(vb.z0); z <= vb.z1; z++) { const sy = S([0, z])[1]; g += `M0 ${sy.toFixed(1)}H${svg.clientWidth}`; }
      parts.push(`<path class="ed-grid" d="${g}"/>`);
    }
    // 底图
    const b = h.background, img = this.bg;
    if (b && img && !this.bgHidden) {
      const sz = b.pxPerMz ?? b.pxPerM;
      const [x, y] = S([-b.origin[0] / b.pxPerM, -b.origin[1] / sz]);
      parts.push(`<image href="${img.url}" x="${x}" y="${y}" width="${img.w / b.pxPerM * s}" height="${img.h / sz * s}" opacity="${b.opacity}" preserveAspectRatio="none"/>`);
    }
    (this.root.querySelector("#ed-opacity") as HTMLInputElement).value = String(b?.opacity ?? 0.5);
    (this.root.querySelector("#ed-bgtoggle") as HTMLElement).textContent = this.bgHidden ? "显示底图" : "隐藏底图";
    // 房间
    for (const r of h.rooms) {
      const [lx, ly] = S(labelPoint(r.polygon));
      parts.push(`<polygon class="ed-room t-${r.type}${r.id === sel ? " sel" : ""}" points="${pts(r.polygon)}"/>`);
      if (s > 18) parts.push(`<text class="ed-rlabel" x="${lx}" y="${ly}">${esc(r.name)}<tspan x="${lx}" dy="1.25em">${polygonArea(r.polygon).toFixed(1)}㎡</tspan></text>`);
    }
    // 墙
    for (const w of h.walls) {
      const { n } = wallFrame(w), t = w.thickness / 2;
      const poly: Vec2[] = [[w.a[0] + n[0] * t, w.a[1] + n[1] * t], [w.b[0] + n[0] * t, w.b[1] + n[1] * t], [w.b[0] - n[0] * t, w.b[1] - n[1] * t], [w.a[0] - n[0] * t, w.a[1] - n[1] * t]];
      parts.push(`<polygon class="ed-wall k-${w.kind}${w.id === sel ? " sel" : ""}" points="${pts(poly)}"/>`);
      for (const o of w.openings) parts.push(this.openingSvg(w, o, o.id === sel));
    }
    // 墙长标注
    if (s > 28) for (const w of h.walls) {
      const { len, d } = wallFrame(w), m = wallPoint(w, len / 2, -(w.thickness / 2 + 10 / s));
      const [x, y] = S(m); let ang = Math.atan2(d[1], d[0]) * 180 / Math.PI;
      if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      parts.push(`<text class="ed-dim${w.id === sel ? " sel" : ""}" x="${x}" y="${y}" transform="rotate(${ang.toFixed(1)} ${x} ${y})">${Math.round(len * 1000)}</text>`);
    }
    // 家具
    for (const it of h.furniture) {
      const fp = itemFootprint(it);
      parts.push(`<polygon class="ed-item${it.fixed ? " fixed" : ""}${it.id === sel ? " sel" : ""}" points="${pts(fp)}"/>`);
      parts.push(`<polyline class="ed-front" points="${pts([fp[3], fp[2]])}"/>`);
      const [cx, cy] = S(it.pos), sz = Math.min(it.size[0], it.size[1]) * s;
      // 只给够大的落地家具标名字，用类型的短名；地毯、窗帘、放在上面的小东西不标，免得字压字
      const label = CATALOG_BY_TYPE[it.type]?.nameZh ?? it.type, flat = NO_LABEL.has(it.type) || !!it.elevation;
      if (!flat && sz > Math.max(30, label.length * 11)) parts.push(`<text class="ed-ilabel" x="${cx}" y="${cy}">${esc(label)}</text>`);
    }
    // 选中的墙、房间：画出可拖的端点
    const f = this.find(sel);
    const handle = (p: Vec2) => { const [x, y] = S(p); return `<circle class="ed-handle" cx="${x}" cy="${y}" r="5"/>`; };
    if (f?.kind === "wall") parts.push(handle(f.wall.a), handle(f.wall.b));
    if (f?.kind === "room") parts.push(...f.room.polygon.map(handle));
    // 正在画的墙链 / 房间
    const c = this.cursor;
    if (this.draft.length) {
      const chain = [...this.draft, ...(c ? [c.p] : [])];
      parts.push(`<polyline class="ed-draft${this.tool === "room" ? " room" : ""}" points="${pts(chain)}"/>`);
      if (c && this.draft.length) {
        const last = this.draft.at(-1)!, L = Math.hypot(c.p[0] - last[0], c.p[1] - last[1]);
        const [x, y] = S(c.p); parts.push(`<text class="ed-live" x="${x + 12}" y="${y - 10}">${Math.round(L * 1000)} mm</text>`);
      }
    }
    if (this.drag?.kind === "room-rect" && c) {
      const a = this.drag.start, p = c.p;
      parts.push(`<polygon class="ed-draft room" points="${pts([a, [p[0], a[1]], p, [a[0], p[1]]])}"/>`);
    }
    if (this.drag?.kind === "recog-rect" && this.rawCursor) {
      const a = this.drag.start, p = this.rawCursor;
      parts.push(`<polygon class="ed-draft" points="${pts([a, [p[0], a[1]], p, [a[0], p[1]]])}"/>`);
    }
    // 吸附提示
    if (c && (this.tool === "wall" || this.tool === "room" || this.drag?.kind === "wallEnd" || this.drag?.kind === "vertex")) {
      for (const [g0, g1] of c.guides) parts.push(`<line class="ed-guide" x1="${S(g0)[0]}" y1="${S(g0)[1]}" x2="${S(g1)[0]}" y2="${S(g1)[1]}"/>`);
      const [x, y] = S(c.p);
      parts.push(c.kind === "point" ? `<rect class="ed-snap" x="${x - 6}" y="${y - 6}" width="12" height="12"/>` : `<circle class="ed-cursor" cx="${x}" cy="${y}" r="4"/>`);
    }
    // 门窗工具：预览要放的位置
    if (this.tool === "opening" && this.rawCursor) {
      const nw = nearestWall(h, this.rawCursor, this.tol);
      if (nw) {
        const w = h.walls.find(w => w.id === nw.id)!, def = OPENING_DEFAULT[this.openingType];
        const pl = placeOnWall(wallFrame(w).len, nw.u, def.width);
        const [x0, y0] = S(wallPoint(w, pl.offset)), [x1, y1] = S(wallPoint(w, pl.offset + pl.width));
        parts.push(`<line class="ed-ghost" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`);
      }
    }
    // 家具工具：预览占地
    if (this.tool === "item" && this.rawCursor) {
      const cat = CATALOG_BY_TYPE[this.itemType];
      parts.push(`<polygon class="ed-ghost-item" points="${pts(itemFootprint({ pos: this.rawCursor, rot: 0, size: cat.defaultSize }))}"/>`);
    }
    // 标定的点
    for (const p of this.calib) { const [x, y] = S(p); parts.push(`<circle class="ed-calpt" cx="${x}" cy="${y}" r="6"/>`); }
    if (this.calib.length === 1 && this.rawCursor) { const [x0, y0] = S(this.calib[0]), [x1, y1] = S(this.rawCursor); parts.push(`<line class="ed-calline" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`); }
    if (this.calib.length === 2) { const [x0, y0] = S(this.calib[0]), [x1, y1] = S(this.calib[1]); parts.push(`<line class="ed-calline" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`); }
    // 比例尺
    const bar = niceLen(120 / s);
    parts.push(`<g class="ed-scale"><path d="M16 ${svg.clientHeight - 16}h${bar * s}"/><text x="16" y="${svg.clientHeight - 22}">${bar >= 1 ? bar + " m" : bar * 100 + " cm"}</text></g>`);
    if (!h.walls.length && !h.rooms.length && !img) parts.push(`<text class="ed-empty" x="${svg.clientWidth / 2}" y="${svg.clientHeight / 2}">点“上传户型图”开始，或者直接用“画墙”画</text>`);
    svg.innerHTML = parts.join("");
  }

  private openingSvg(w: Wall, o: Opening, selected: boolean): string {
    const S = this.S, t = w.thickness / 2;
    const P = (u: number, p: number) => S(wallPoint(w, u, p));
    const a = o.offset, b = o.offset + o.width;
    const gap = [P(a, t), P(b, t), P(b, -t), P(a, -t)].map(q => q.join(",")).join(" ");
    let sym = "";
    if (o.type === "door" || o.type === "entry") {
      const side = o.side ?? 1, hinge = (o.hinge ?? "a") === "a" ? a : b, free = hinge === a ? b : a;
      const leafEnd = P(hinge, side * (t + o.width)), h0 = P(hinge, side * t), fr = P(free, side * t);
      const r = o.width * this.view.s;
      const sweep = (hinge === a ? side > 0 : side < 0) ? 1 : 0;
      sym = `<line class="ed-leaf" x1="${h0[0]}" y1="${h0[1]}" x2="${leafEnd[0]}" y2="${leafEnd[1]}"/><path class="ed-swing" d="M${leafEnd[0]} ${leafEnd[1]}A${r} ${r} 0 0 ${sweep} ${fr[0]} ${fr[1]}"/>`;
    } else if (o.type === "window") {
      for (const q of [-t * 0.5, 0, t * 0.5]) { const [x0, y0] = P(a, q), [x1, y1] = P(b, q); sym += `<line class="ed-win" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`; }
    } else if (o.type === "sliding") {
      const m = (a + b) / 2;
      for (const [u0, u1, q] of [[a, m + 0.05, -t * 0.3], [m - 0.05, b, t * 0.3]] as const) { const [x0, y0] = P(u0, q), [x1, y1] = P(u1, q); sym += `<line class="ed-win" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`; }
    }
    return `<polygon class="ed-gap t-${o.type}${selected ? " sel" : ""}" points="${gap}"/>${sym}`;
  }
}

/* ---------- 小工具 ---------- */
const same = (p: Vec2, q: Vec2) => Math.abs(p[0] - q[0]) < 1e-3 && Math.abs(p[1] - q[1]) < 1e-3;
const normRot = (r: number) => { let v = ((r % 360) + 360) % 360; if (v > 180) v -= 360; return v; };
function ids(h: House): string[] {
  return [...h.walls.flatMap(w => [w.id, ...w.openings.map(o => o.id)]), ...h.rooms.map(r => r.id), ...h.furniture.map(f => f.id), ...h.extras.map(e => e.id)];
}
const NO_LABEL = new Set(["rug", "curtain", "deck_tiles", "pendant_lamp", "table_lamp", "tv", "monitor", "stove", "shower"]);
function niceLen(v: number) { for (const c of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20]) if (c >= v) return c; return 50; }
function groupedCatalog() {
  const cats = [...new Set(CATALOG.map(c => c.category))];
  return cats.map(cat => `<optgroup label="${cat}">${CATALOG.filter(c => c.category === cat).map(c => `<option value="${c.type}">${c.nameZh}</option>`).join("")}</optgroup>`).join("");
}

/** 按 id 删除墙、门窗、房间或家具（删墙会连同墙上的门窗一起删） */
export function deleteById(app: App, id: string) {
  const h = app.store.house;
  if (h.furniture.some(f => f.id === id && f.fixed)) { toast("这是房子原有的设施。要删的话先在右侧面板取消“原有设施”。", true); return; }
  app.store.commit("删除", d => {
    d.furniture = d.furniture.filter(f => f.id !== id);
    d.rooms = d.rooms.filter(r => r.id !== id);
    d.walls = d.walls.filter(w => w.id !== id);
    for (const w of d.walls) w.openings = w.openings.filter(o => o.id !== id);
    // 家具所在房间被删了，就不再记房间
    for (const f of d.furniture) if (f.room && !d.rooms.some(r => r.id === f.room)) delete f.room;
  });
  app.select(null);
}
