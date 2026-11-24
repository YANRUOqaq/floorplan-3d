/**
 * 3D 浏览器：渲染器、灯光、第一人称走动、鸟瞰和俯视、点选家具。
 * 从原 01 房页面移植。原来写死的走动范围、视角、阴影范围，现在都由 scene.ts 按数据算出来。
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { House } from "../model/schema";
import { createMaterials } from "./materials";
import { buildHouse, disposeTree, type BuiltHouse, type View } from "./scene";
import { noRay } from "./prims";
import { esc } from "../ui/dom";

const EYE = 1.6;

export interface ViewerEvents {
  /** 选中或取消选中家具 */
  onSelect?: (id: string | null) => void;
  /** 视角列表变了（换了户型） */
  onViews?: (views: View[], current: string) => void;
}

export class Viewer {
  readonly el: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 0.03, 200);
  private controls: OrbitControls;
  private sun = new THREE.DirectionalLight(0xffeed6, 2.9 * Math.PI);
  private ground: THREE.Mesh;
  private m = createMaterials();
  private built: BuiltHouse | null = null;
  private house: House | null = null;
  private wallCache: { full?: THREE.Group; cut?: THREE.Group } = {};
  private wallGroup: THREE.Group | null = null;
  private selBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color("#2E4A6E"));
  private ringMark = new THREE.Group();
  private labelBox: HTMLElement; private fade: HTMLElement; private hint: HTMLElement;
  private labelEls: { el: HTMLElement; v: THREE.Vector3 }[] = [];
  private dirty = true;
  private mode3d: "walk" | "orbit" | "" = "";
  private current = "";
  private fly: { t0: number; from: { pos: THREE.Vector3; tgt: THREE.Vector3 }; to: { pos: THREE.Vector3; tgt: THREE.Vector3 } } | null = null;
  private fp = { x: 1, z: 1, yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, fov: 62, tFov: 62, anim: null as null | { x0: number; z0: number; x1: number; z1: number; t0: number; dur: number } };
  private reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private coarse = matchMedia("(pointer: coarse)").matches;
  selected: string | null = null;

  constructor(container: HTMLElement, private ev: ViewerEvents = {}) {
    this.el = container;
    const mk = (cls: string) => { const d = document.createElement("div"); d.className = cls; container.appendChild(d); return d; };
    this.labelBox = mk("labels"); this.fade = mk("fade"); this.hint = mk("hint");

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.92;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    container.prepend(r.domElement);
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.9;   // 和原页面截图对比后调的

    const c = this.controls = new OrbitControls(this.camera, r.domElement);
    c.enableDamping = true; c.dampingFactor = 0.08; c.enabled = false;
    c.maxPolarAngle = Math.PI * 0.495; c.minDistance = 1; c.maxDistance = 60;
    c.screenSpacePanning = true;
    c.addEventListener("start", () => { this.fly = null; });
    c.addEventListener("change", () => { this.dirty = true; });

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd9cfc1, 0.12 * Math.PI));
    const s = this.sun;
    s.castShadow = true; s.shadow.mapSize.set(2048, 2048); s.shadow.bias = -0.0003; s.shadow.normalBias = 0.02;
    this.scene.add(s, s.target);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.ShadowMaterial({ opacity: 0.12 }));
    this.ground.rotation.x = -Math.PI / 2; this.ground.receiveShadow = true; this.scene.add(this.ground);
    this.selBox.visible = false; this.scene.add(this.selBox);

    const ringM = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
    const r1 = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.18, 48).rotateX(-Math.PI / 2), ringM);
    const r2 = new THREE.Mesh(new THREE.CircleGeometry(0.15, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }));
    this.ringMark.add(r1, r2); this.ringMark.children.forEach(o => { o.raycast = noRay; o.renderOrder = 3; }); this.ringMark.visible = false; this.scene.add(this.ringMark);

    this.bindInput();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme());
    new MutationObserver(() => this.applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    new ResizeObserver(() => this.resize()).observe(container); this.resize();
    new IntersectionObserver(es => { this.visible = es[0].isIntersecting; if (this.visible) this.dirty = true; }).observe(container);
    requestAnimationFrame(this.loop);
  }

  /* ---------- 载入户型 ---------- */
  load(house: House) {
    this.house = house;
    if (this.built) {
      for (const g of [this.built.fixed, this.built.ceil, this.built.items]) { this.scene.remove(g); disposeTree(g); }
    }
    for (const g of Object.values(this.wallCache)) if (g) { this.scene.remove(g); disposeTree(g); }
    this.wallCache = {}; this.wallGroup = null;
    const b = this.built = buildHouse(house, this.m);
    this.scene.add(b.fixed, b.ceil, b.items);
    // 阳光从西南方高处照进来；阴影相机罩住整套房子
    const [cx, cz] = b.center, half = Math.hypot(b.bbox.x1 - b.bbox.x0, b.bbox.z1 - b.bbox.z0) / 2 + 0.6;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx - 7.6, 13, cz + 14);
    Object.assign(this.sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 60 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.ground.position.set(cx, -0.13, cz);
    // 房间标签
    this.labelBox.innerHTML = "";
    this.labelEls = b.labels.map(l => {
      const el = document.createElement("div"); el.className = "rl";
      el.innerHTML = `${esc(l.name)}<small>${l.area.toFixed(1)}㎡</small>`;
      this.labelBox.appendChild(el); return { el, v: new THREE.Vector3(l.x, 1.25, l.z) };
    });
    if (this.selected && !b.itemGroups.has(this.selected)) this.select(null); else if (this.selected) this.select(this.selected);
    const keep = b.views.find(v => v.key === this.current);
    const first = keep ?? b.views.find(v => !v.orbit && house.rooms.find(r => r.id === v.key)?.type === "living") ?? b.views.find(v => !v.orbit) ?? b.views[0];
    this.mode3d = "";
    // 同一个视角下重建（比如改了家具）时不重置相机
    const cam = keep ? { pos: this.camera.position.clone(), tgt: this.controls.target.clone(), fp: { ...this.fp } } : null;
    this.setView(first.key, true);
    if (cam && keep) {
      if (keep.orbit) { this.camera.position.copy(cam.pos); this.controls.target.copy(cam.tgt); this.controls.update(); }
      else Object.assign(this.fp, cam.fp, { anim: null });
    }
    this.ev.onViews?.(b.views, first.key);
    this.touch();
  }

  get views() { return this.built?.views ?? []; }
  get currentView() { return this.current; }

  private touch() { this.dirty = true; this.renderer.shadowMap.needsUpdate = true; }

  private setWalls(cut: boolean) {
    if (!this.built) return;
    const key = cut ? "cut" : "full";
    const g = this.wallCache[key] ??= this.built.walls(cut);
    if (this.wallGroup === g) return;
    if (this.wallGroup) this.scene.remove(this.wallGroup);
    this.scene.add(g); this.wallGroup = g;
    this.touch();
  }

  /* ---------- 视角 ---------- */
  private lookAt(x: number, y: number, z: number, instant = false) {
    const fp = this.fp, dx = x - fp.x, dz = z - fp.z, dy = y - EYE;
    const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    fp.tYaw = fp.yaw + wrap(yaw - fp.yaw); fp.tPitch = clamp(pitch, -1.25, 1.25);
    if (instant) { fp.yaw = fp.tYaw; fp.pitch = fp.tPitch; }
  }
  private setHint() {
    this.hint.textContent = this.mode3d === "walk"
      ? (this.coarse ? "拖动转头 · 点地面走过去 · 双指缩放视野 · 点家具看详情" : "拖动转头 · 点地面走过去 · 滚轮缩放视野 · W A S D 走动 · 点家具看详情")
      : "拖动旋转 · 滚轮或双指缩放 · 右键或双指平移 · 点家具看详情";
  }
  private applyStage(orbit: boolean) {
    const b = this.built!;
    this.mode3d = orbit ? "orbit" : "walk";
    this.controls.enabled = orbit;
    this.setWalls(orbit);
    b.ceil.visible = !orbit;
    b.orbitHidden.forEach(o => { o.visible = !orbit; });
    this.labelBox.hidden = !orbit;
    this.ground.visible = orbit;
    this.sun.intensity = (orbit ? 1.35 : 2.9) * Math.PI;
    this.camera.fov = orbit ? 45 : this.fp.fov; this.camera.updateProjectionMatrix();
    this.applyTheme(); this.setHint(); this.ringMark.visible = false;
    this.renderer.domElement.style.cursor = orbit ? "grab" : "";
    this.touch();
  }
  private blink(fn: () => void) {
    if (this.reduceMotion) { fn(); return; }
    this.fade.classList.add("on");
    setTimeout(() => { fn(); requestAnimationFrame(() => this.fade.classList.remove("on")); }, 170);
  }
  setView(key: string, instant = false, after?: () => void) {
    const v = this.views.find(x => x.key === key); if (!v || !this.built) return;
    this.current = key;
    const go = () => {
      if (v.orbit) {
        const wasOrbit = this.mode3d === "orbit";
        if (!wasOrbit) this.applyStage(true);
        const to = { pos: new THREE.Vector3(...v.pos!), tgt: new THREE.Vector3(...v.tgt!) };
        if (key === "overview") to.pos.sub(to.tgt).multiplyScalar(clamp(1 / this.camera.aspect, 1, 1.45)).add(to.tgt);
        if (instant || !wasOrbit || this.reduceMotion) { this.camera.position.copy(to.pos); this.controls.target.copy(to.tgt); this.fly = null; this.controls.update(); }
        else this.fly = { t0: performance.now(), from: { pos: this.camera.position.clone(), tgt: this.controls.target.clone() }, to };
      } else {
        if (this.mode3d !== "walk") this.applyStage(false);
        const fp = this.fp;
        fp.anim = null; fp.x = v.at![0]; fp.z = v.at![1]; fp.tFov = fp.fov = this.camera.aspect < 1 ? 76 : 62;   // 竖屏视野放宽
        this.lookAt(...v.look!, true);
      }
      after?.();
      this.dirty = true;
    };
    if (instant) go(); else this.blink(go);
    this.ev.onViews?.(this.views, key);
  }

  /** 对比截图用：直接把人放到某个位置、看向某一点 */
  standAt(x: number, z: number, look: [number, number, number]) {
    if (this.mode3d !== "walk") this.applyStage(false);
    Object.assign(this.fp, { x, z, anim: null });
    this.lookAt(...look, true); this.dirty = true;
  }

  /* ---------- 选中 ---------- */
  itemBox(id: string) {
    const b = new THREE.Box3(), g = this.built?.itemGroups.get(id);
    if (g && g.visible) g.traverse(o => { if ((o as THREE.Mesh).isMesh && o.raycast !== noRay && !o.userData.blob) b.expandByObject(o); });
    return b;
  }
  select(id: string | null) {
    this.selected = id; this.dirty = true;
    if (!id) { this.selBox.visible = false; this.ev.onSelect?.(null); return; }
    const b = this.itemBox(id);
    this.selBox.box.copy(b); this.selBox.visible = !b.isEmpty();
    this.ev.onSelect?.(id);
  }
  /** 走到家具所在的房间、转头看它并选中 */
  locate(id: string) {
    const it = this.house?.furniture.find(f => f.id === id); if (!it || !this.built) return;
    const room = it.room && this.views.find(v => v.key === it.room && !v.orbit) ? it.room : this.views.find(v => !v.orbit)?.key;
    if (!room) return;
    this.setView(room, false, () => {
      this.select(id);
      const b = this.itemBox(id); if (b.isEmpty()) return;
      const c = b.getCenter(new THREE.Vector3()); this.lookAt(c.x, Math.min(c.y, 1.4), c.z);
    });
  }

  /* ---------- 拾取：家具、地面；墙挡住的不算，玻璃和纱帘可以透过去 ---------- */
  private ray = new THREE.Raycaster(); private ndc = new THREE.Vector2();
  private pick(cx: number, cy: number): { id?: string; floor?: THREE.Vector3 } {
    if (!this.built) return {};
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set((cx - r.left) / r.width * 2 - 1, -(cy - r.top) / r.height * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const targets = [this.wallGroup, this.built.fixed, this.built.ceil, this.built.items].filter(Boolean) as THREE.Object3D[];
    for (const h of this.ray.intersectObjects(targets, true)) {
      if (!shown(h.object)) continue;
      const mt = (h.object as THREE.Mesh).material as THREE.Material;
      if (mt === this.m.mat.glass || mt === this.m.mat.sheer) continue;
      if (h.object.userData.floor) return { floor: h.point };
      let o: THREE.Object3D | null = h.object; while (o && !o.userData.id) o = o.parent;
      if (o) return { id: o.userData.id };
      return {};
    }
    return {};
  }

  /* ---------- 走动 ---------- */
  private walkTo(p: THREE.Vector3) {
    const fp = this.fp, walkable = this.built!.walkable;
    let tx = p.x, tz = p.z;
    if (!walkable(tx, tz)) {   // 点在家具上：退到最近能站的点
      let ok = false;
      for (let s = 0.05; s <= 1.2 && !ok; s += 0.05) {
        const dx = fp.x - tx, dz = fp.z - tz, L = Math.hypot(dx, dz) || 1;
        const nx = tx + dx / L * s, nz = tz + dz / L * s;
        if (walkable(nx, nz)) { tx = nx; tz = nz; ok = true; }
      }
      if (!ok) return;
    }
    const L = Math.hypot(tx - fp.x, tz - fp.z);
    let clear = true;
    for (let s = 0; s <= L; s += 0.08) { const k = s / (L || 1); if (!walkable(fp.x + (tx - fp.x) * k, fp.z + (tz - fp.z) * k)) { clear = false; break; } }
    if (clear && !this.reduceMotion) fp.anim = { x0: fp.x, z0: fp.z, x1: tx, z1: tz, t0: performance.now(), dur: clamp(L / 2.2 * 1000, 320, 1100) };
    else this.blink(() => { fp.x = tx; fp.z = tz; fp.anim = null; this.dirty = true; });
  }

  /* ---------- 输入 ---------- */
  private keys = new Set<string>();
  private bindInput() {
    const el = this.renderer.domElement, fp = this.fp, viewer = this.el;
    const pointers = new Map<number, { x: number; y: number }>();
    let downInfo: { x: number; y: number; t: number; moved: number } | null = null;
    let pinch0: { d: number; fov: number } | null = null;
    el.addEventListener("pointerdown", e => {
      viewer.focus({ preventScroll: true });
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) downInfo = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
      if (this.mode3d === "walk") {
        try { el.setPointerCapture(e.pointerId); } catch { /* 有的浏览器不支持 */ }
        if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: fp.tFov }; }
        fp.anim = null;
      }
    });
    el.addEventListener("pointermove", e => {
      const prev = pointers.get(e.pointerId);
      if (this.mode3d === "walk" && prev) {
        if (pointers.size === 1) {
          const dx = e.clientX - prev.x, dy = e.clientY - prev.y, k = 0.0042 * (fp.fov / 62);
          fp.tYaw += dx * k; fp.tPitch = clamp(fp.tPitch + dy * k, -1.25, 1.25);
          if (downInfo) downInfo.moved += Math.abs(dx) + Math.abs(dy);
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2 && pinch0) {
          const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
          fp.tFov = clamp(pinch0.fov * pinch0.d / Math.max(d, 1), 30, 80);
          if (downInfo) downInfo.moved += 99;
        }
        this.dirty = true;
      } else if (prev) {
        if (downInfo) downInfo.moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (!prev && e.pointerType === "mouse") this.hover(e.clientX, e.clientY);
    });
    const endPointer = (e: PointerEvent) => {
      const had = pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch0 = null;
      if (!had || !downInfo || pointers.size) return;
      const tap = downInfo.moved < 8 && performance.now() - downInfo.t < 600;
      downInfo = null;
      if (!tap) return;
      const p = this.pick(e.clientX, e.clientY);
      if (p.id) this.select(p.id);
      else if (p.floor && this.mode3d === "walk") { this.select(null); this.walkTo(p.floor); }
      else this.select(null);
    };
    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", e => { pointers.delete(e.pointerId); downInfo = null; pinch0 = null; });
    el.addEventListener("pointerleave", () => { if (this.ringMark.visible) { this.ringMark.visible = false; this.dirty = true; } });
    el.addEventListener("wheel", e => {
      if (this.mode3d !== "walk") return;
      e.preventDefault();
      fp.tFov = clamp(fp.tFov + e.deltaY * 0.03, 30, 80); this.dirty = true;
    }, { passive: false });
    viewer.addEventListener("keydown", e => { if (this.mode3d === "walk" && MOVE_KEYS[e.code]) { this.keys.add(e.code); e.preventDefault(); } });
    viewer.addEventListener("keyup", e => this.keys.delete(e.code));
    viewer.addEventListener("blur", () => this.keys.clear());
  }
  private hover(cx: number, cy: number) {
    const p = this.pick(cx, cy);
    const showRing = this.mode3d === "walk" && !!p.floor && this.built!.walkable(p.floor.x, p.floor.z);
    if (showRing) this.ringMark.position.set(p.floor!.x, 0.02, p.floor!.z);
    if (this.ringMark.visible !== showRing || showRing) this.dirty = true;
    this.ringMark.visible = showRing;
    this.renderer.domElement.style.cursor = p.id ? "pointer" : this.mode3d === "walk" ? (showRing ? "pointer" : "grab") : "grab";
  }

  /* ---------- 主题、尺寸、渲染循环 ---------- */
  private sky = new THREE.Color("#DDE6EC");
  private applyTheme() {
    if (this.mode3d === "walk") this.scene.background = this.sky;
    else {
      const c = getComputedStyle(this.el).getPropertyValue("--scene").trim() || "#E6E8E3";
      this.scene.background = new THREE.Color(c);
      (this.ground.material as THREE.ShadowMaterial).opacity = new THREE.Color(c).getHSL({ h: 0, s: 0, l: 0 }).l < 0.4 ? 0.3 : 0.12;
    }
    const dark = getComputedStyle(this.el).getPropertyValue("--dark").trim() === "1";
    (this.selBox.material as THREE.LineBasicMaterial).color.set(dark && this.mode3d === "orbit" ? "#93B2DA" : "#2E4A6E");
    this.dirty = true;
  }
  private resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.dirty = true;
  }
  /** 外面改了容器大小或显隐时调用 */
  refresh() { this.resize(); this.dirty = true; }

  private updateLabels() {
    if (this.labelBox.hidden) return;
    const w = this.el.clientWidth, h = this.el.clientHeight, v = new THREE.Vector3();
    for (const l of this.labelEls) {
      v.copy(l.v).project(this.camera);
      const vis = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      l.el.hidden = !vis;
      if (vis) l.el.style.transform = `translate(${(v.x + 1) / 2 * w}px, ${(1 - v.y) / 2 * h}px) translate(-50%, -50%)`;
    }
  }
  private visible = true;
  private last = performance.now();
  private lastM = new THREE.Matrix4(); private lastP = new THREE.Matrix4();
  private loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    if (!this.visible || document.hidden || !this.built || !this.el.clientWidth) return;
    const fp = this.fp, cam = this.camera;
    if (this.mode3d === "walk") {
      const k = this.reduceMotion ? 1 : 1 - Math.exp(-dt * 12);
      fp.yaw += (fp.tYaw - fp.yaw) * k; fp.pitch += (fp.tPitch - fp.pitch) * k; fp.fov += (fp.tFov - fp.fov) * k;
      if (fp.anim) {
        const t = Math.min(1, (now - fp.anim.t0) / fp.anim.dur), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        fp.x = fp.anim.x0 + (fp.anim.x1 - fp.anim.x0) * e; fp.z = fp.anim.z0 + (fp.anim.z1 - fp.anim.z0) * e;
        if (t >= 1) fp.anim = null;
      }
      if (this.keys.size) {
        let f = 0, s = 0; this.keys.forEach(c => { f += MOVE_KEYS[c][1]; s += MOVE_KEYS[c][0]; });
        const sp = 1.6 * dt, sy = Math.sin(fp.yaw), cy = Math.cos(fp.yaw), walk = this.built.walkable;
        const nx = fp.x + (-sy * f + cy * s) * sp, nz = fp.z + (-cy * f - sy * s) * sp;
        if (walk(nx, nz)) { fp.x = nx; fp.z = nz; } else if (walk(nx, fp.z)) fp.x = nx; else if (walk(fp.x, nz)) fp.z = nz;
      }
      cam.position.set(fp.x, EYE, fp.z);
      cam.rotation.set(fp.pitch, fp.yaw, 0, "YXZ");
      if (Math.abs(cam.fov - fp.fov) > 1e-3) { cam.fov = fp.fov; cam.updateProjectionMatrix(); }
    } else {
      if (this.fly) {
        const k = clamp((now - this.fly.t0) / 900, 0, 1), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        cam.position.lerpVectors(this.fly.from.pos, this.fly.to.pos, e);
        this.controls.target.lerpVectors(this.fly.from.tgt, this.fly.to.tgt, e);
        if (k >= 1) this.fly = null;
      }
      this.controls.update();
    }
    cam.updateMatrixWorld();
    if (!this.dirty && cam.matrixWorld.equals(this.lastM) && cam.projectionMatrix.equals(this.lastP)) return;
    this.dirty = false; this.lastM.copy(cam.matrixWorld); this.lastP.copy(cam.projectionMatrix);
    this.renderer.render(this.scene, cam);
    this.updateLabels();
  };
}

const MOVE_KEYS: Record<string, [number, number]> = { KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const shown = (o: THREE.Object3D | null) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
