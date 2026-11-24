/**
 * 程序生成纹理：地板、木纹、布纹、乳胶漆、瓷砖、花岗岩、防腐木都用 canvas 现画，不需要图片文件。
 * 同一张图同时当颜色贴图和凹凸贴图。UV 按世界坐标（米）写，所以 repeat = 1 / 一张图对应的米数。
 * 从原 01 房页面移植；地板改成灰度图，颜色由材质的 color 决定，这样可以换地板颜色。
 */
import * as THREE from "three";

export function rng(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;
function makeTex(w: number, h: number, draw: Draw, mu: number, mv: number) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / mu, 1 / mv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function grainLines(g: CanvasRenderingContext2D, r: () => number, x0: number, x1: number, h: number, n: number, rgb: string, aMin: number, aMax: number) {
  for (let k = 0; k < n; k++) {
    const x = x0 + r() * (x1 - x0), ph = r() * 9, amp = 0.6 + r() * 2.2;
    g.strokeStyle = `rgba(${rgb},${aMin + r() * (aMax - aMin)})`; g.lineWidth = 0.5 + r() * 1.3;
    g.beginPath(); g.moveTo(x, 0);
    for (let y = 0; y <= h; y += 32) g.lineTo(x + Math.sin(y / 210 + ph) * amp + Math.sin(y / 47 + ph * 2) * 0.4, y);
    g.stroke();
  }
}
function tileDraw(nx: number, ny: number, base: string, grout: string, seed: number): Draw {
  return (g, w, h) => {
    const r = rng(seed), sx = w / nx, sy = h / ny;
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      g.fillStyle = `rgba(${r() < 0.5 ? "255,255,255" : "120,110,100"},${r() * 0.035})`; g.fillRect(i * sx, j * sy, sx, sy);
    }
    for (let k = 0; k < 600; k++) { g.fillStyle = `rgba(255,255,255,${r() * 0.05})`; g.fillRect(r() * w, r() * h, 2 + r() * 8, 2 + r() * 8); }
    g.fillStyle = grout;
    for (let i = 0; i <= nx; i++) g.fillRect(i * sx - 1, 0, 2, h);
    for (let j = 0; j <= ny; j++) g.fillRect(0, j * sy - 1, w, 2);
  };
}

/** 地板灰度底色（0~255）。材质颜色 = 想要的地板颜色 ÷ 这个灰度，见 materials.ts 的 floorTint() */
export const FLOOR_GRAY = 226;

let cache: ReturnType<typeof build> | null = null;
/** 纹理只生成一次，多次重建场景时复用 */
export function textures() { return cache ??= build(); }

function build() {
  // 地板：8 条 15 cm 宽、约 1.2 m 长的板，错缝；色差和木纹都压得很淡
  const floor = makeTex(1024, 2048, (g, w, h) => {
    const r = rng(11), n = 8, pw = w / n, base = FLOOR_GRAY;
    for (let i = 0; i < n; i++) {
      const x0 = i * pw, j1 = r() * h / 2, j2 = j1 + h / 2 + (r() - 0.5) * h * 0.25;
      for (const [a, b] of [[j1, j2], [j2, j1 + h]]) {
        const v = (r() - 0.5) * 16; r();
        g.fillStyle = `rgb(${base + v},${base + v},${base + v})`;
        for (const off of [0, -h]) g.fillRect(x0, a + off, pw, b - a);
      }
      grainLines(g, r, x0 + 2, x0 + pw - 2, h, 70, "110,100,92", 0.025, 0.08);
      g.fillStyle = "rgba(255,255,255,0.05)"; g.fillRect(x0 + pw * 0.15, 0, pw * 0.25, h);
      g.fillStyle = "rgba(70,60,52,0.30)"; g.fillRect(x0, 0, 1, h);
      for (const y of [j1, j2 % h]) g.fillRect(x0, y, pw, 1);
    }
  }, 1.2, 2.4);
  // 家具木纹：浅色底，颜色由材质决定
  const grain = makeTex(256, 1024, (g, w, h) => {
    const r = rng(5); g.fillStyle = "#F6F0E7"; g.fillRect(0, 0, w, h);
    for (let k = 0; k < 7; k++) { g.fillStyle = `rgba(190,150,105,${0.03 + r() * 0.05})`; g.fillRect(r() * w, 0, 6 + r() * 30, h); }
    grainLines(g, r, 0, w, h, 90, "150,105,62", 0.04, 0.16);
  }, 0.3, 1.2);
  const fabric = makeTex(256, 256, (g, w) => {
    const r = rng(8); g.fillStyle = "#F4F2EE"; g.fillRect(0, 0, w, w);
    for (let y = 0; y < w; y += 2) { g.fillStyle = `rgba(120,110,95,${0.025 + r() * 0.04})`; g.fillRect(0, y, w, 1); }
    for (let x = 0; x < w; x += 2) { g.fillStyle = `rgba(120,110,95,${0.02 + r() * 0.035})`; g.fillRect(x, 0, 1, w); }
    for (let k = 0; k < 500; k++) { g.fillStyle = `rgba(90,80,70,${r() * 0.05})`; g.fillRect(r() * w, r() * w, 1 + r() * 3, 1); }
  }, 0.12, 0.12);
  const paint = makeTex(256, 256, (g, w) => {
    const r = rng(2); g.fillStyle = "#FBFAF8"; g.fillRect(0, 0, w, w);
    for (let k = 0; k < 2400; k++) { g.fillStyle = r() < 0.5 ? `rgba(0,0,0,${r() * 0.025})` : `rgba(255,255,255,${r() * 0.4})`; g.fillRect(r() * w, r() * w, 1 + r() * 2, 1 + r() * 2); }
  }, 0.5, 0.5);
  const tile = makeTex(512, 512, tileDraw(2, 2, "#DCD7CE", "#C9C2B7", 3), 1.6, 1.6);
  const tileSmall = makeTex(512, 512, tileDraw(4, 4, "#E6E2DB", "#CDC7BD", 4), 1.2, 1.2);
  const wallTile = makeTex(256, 512, tileDraw(1, 1, "#F4F3F0", "#D9D6D0", 6), 0.3, 0.6);
  const granite = makeTex(256, 256, (g, w) => {
    const r = rng(9); g.fillStyle = "#857A70"; g.fillRect(0, 0, w, w);
    const cols = ["#2D2926", "#E8E2DA", "#5B4B40", "#A39385", "#1E1B19"];
    for (let k = 0; k < 2600; k++) { g.fillStyle = cols[k % cols.length]; g.fillRect(r() * w, r() * w, 1 + r() * 3, 1 + r() * 3); }
  }, 0.5, 0.5);
  const deck = makeTex(512, 512, (g, w, h) => {
    const r = rng(13); g.fillStyle = "#9C7552"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) { g.fillStyle = `rgba(${r() < 0.5 ? "255,230,200" : "60,35,20"},${r() * 0.08})`; g.fillRect(i * w / 4, 0, w / 4, h); }
    grainLines(g, r, 0, w, h, 60, "70,45,25", 0.05, 0.15);
    g.fillStyle = "rgba(40,25,15,0.55)"; for (let i = 0; i <= 4; i++) g.fillRect(i * w / 4 - 2, 0, 4, h);
    g.fillRect(0, 0, w, 3);
  }, 0.3, 0.3);
  // 接触阴影：柔边圆角矩形；墙角暗角：一边黑一边透明的渐变
  const blob = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d")!;
    g.shadowColor = "rgba(0,0,0,1)"; g.shadowBlur = 22; g.shadowOffsetX = 1000; g.fillStyle = "#000";
    g.fillRect(-1000 + 30, 30, 68, 68);
    return new THREE.CanvasTexture(c);
  })();
  const edge = (() => {
    const c = document.createElement("canvas"); c.width = 64; c.height = 4; const g = c.getContext("2d")!;
    const gr = g.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, "rgba(0,0,0,1)"); gr.addColorStop(0.35, "rgba(0,0,0,0.35)"); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 4); return new THREE.CanvasTexture(c);
  })();
  return { floor, grain, fabric, paint, tile, tileSmall, wallTile, granite, deck, blob, edge };
}
