/**
 * 出效果图：把当前视角用路径追踪渲染成一张接近照片的图，或者站在房间里出一张 720 全景图。
 *
 * 为什么要另外渲染一遍：3D 浏览用的是 WebGL 实时光栅化，快，但只算直射光，没有光线在墙、地、家具之间的反弹，
 * 墙角不会自然变暗，木地板的暖色也映不到墙上，看起来像游戏截图。路径追踪模拟光线多次反弹，商用的装修效果图都这样出；
 * 代价是慢，一张要几十秒，所以只在用户点“出效果图”时做。
 *
 * 用的库：three-gpu-pathtracer（WebGPU 路径追踪，MIT）+ oidn-webgpu（Intel Open Image Denoise 的 WebGPU 版，MIT）降噪。
 * 资源（public/render/）：Poly Haven 的晴天天空 HDRI（CC0）当窗外的天光；OIDN 的降噪网络权重（Apache-2.0）。
 * 这个模块连同上面的库只在第一次出图时按需加载，不影响打开页面的速度。
 *
 * 2026-11-25 用 RX 7800 XT 实测示例客厅：1080p、每像素 64 次采样加降噪约 23 秒（含约 5 秒编译着色器）。
 * 需要 WebGPU：电脑上的 Chrome、Edge 可以；不支持的浏览器在界面上提示。
 */
import * as THREE from "three/webgpu";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { WebGPUPathTracer, OIDNDenoiser } from "three-gpu-pathtracer/webgpu";
import { EquirectCamera } from "three-gpu-pathtracer/src/objects/EquirectCamera.js";
import { GenerateMeshBVHWorker } from "three-mesh-bvh/worker";
import { initUNetFromURL } from "oidn-webgpu";
import { createMaterials } from "./materials";
import { buildHouse, disposeTree } from "./scene";
import type { Shot } from "./viewer";

const ASSETS = import.meta.env.BASE_URL + "render/";

export interface RenderProgress {
  stage: "准备场景" | "编译着色器" | "渲染" | "降噪";
  /** 渲染阶段：每个像素已经采样的次数 */
  samples?: number;
  /** 毫秒 */
  elapsed: number;
}
export interface RenderOptions {
  /** still：当前视角；pano：站在原地的 720 全景（等距柱状投影，宽是高的两倍） */
  kind: "still" | "pano";
  width: number;
  height: number;
  /** 每个像素采样多少次，越多噪点越少，时间和次数成正比 */
  samples: number;
  /** 渲染过程画在这块画布上，可以边算边看 */
  canvas: HTMLCanvasElement;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
}

/** 浏览器能不能出效果图 */
export async function webgpuReady(): Promise<boolean> {
  try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; }
}

/** 渲染一张图，返回 PNG */
export async function renderShot(shot: Shot, o: RenderOptions): Promise<Blob> {
  const t0 = performance.now();
  const progress = (p: Omit<RenderProgress, "elapsed">) => o.onProgress?.({ ...p, elapsed: performance.now() - t0 });
  progress({ stage: "准备场景" });
  const renderer = new THREE.WebGPURenderer({ canvas: o.canvas, antialias: false });
  let pt: WebGPUPathTracer | null = null, cleanup = () => {};
  try {
    await renderer.init();
    // 拿不到 WebGPU 设备时 three.js 会悄悄退回 WebGL2，路径追踪在 WebGL2 上跑不了，只会报一串看不懂的着色器错误。
    // 2026-11-25 用无头 Chrome 连续出图时实测偶尔会这样（同一台机器重试就好）
    if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error("这次没能启用显卡的 WebGPU（浏览器退回了 WebGL），出不了效果图。请重试；还不行就重启浏览器。");
    renderer.setPixelRatio(1);
    renderer.setSize(o.width, o.height, false);
    // 色调映射用 AgX：同机位对比时 ACES 把木地板压得偏橙、Neutral 偏暗，AgX 最接近照片
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = shot.orbit ? 1.1 : 1.2;

    const built = await buildScene(shot);
    cleanup = built.dispose;
    const camera = o.kind === "pano" ? panoCamera(shot) : stillCamera(shot, o.width / o.height);
    if (o.signal?.aborted) throw abortError();

    pt = new WebGPUPathTracer(renderer);
    pt.setBVHWorker(GenerateMeshBVHWorker);
    pt.maxSamples = o.samples;
    pt.maxBounces = 8;
    // 默认每帧只走 25 万步，是为了边转视角边渲染时不卡；这里只出一张图，调大后实测快一倍多（400 万步以上不再变快）
    pt.frameBudget = 4_000_000;
    const denoiser = new OIDNDenoiser({ initUNetFromURL, auxWeightsUrl: ASSETS + "rt_hdr_alb_nrm.tza" });
    pt.setDenoiser(denoiser);
    const tracer = pt;
    tracer.addEventListener("progress", (e: { stage: string; samples?: { min: number } }) => {
      if (e.stage === "compiling") progress({ stage: "编译着色器" });
      else if (e.stage === "rendering") progress({ stage: "渲染", samples: e.samples?.min ?? 0 });
      else if (e.stage === "denoising") progress({ stage: "降噪" });
    });
    await tracer.setSceneAsync(built.scene, camera);

    // 渲染循环：每次排一批采样，等显卡做完再排下一批。不用 requestAnimationFrame：窗口被别的窗口挡住时
    // 浏览器会把它压到每秒一两次，2026-11-25 实测同一张图从约 15 秒拖到 100 秒；出图时用户常会切去干别的
    const queue = (renderer.backend as { device?: GPUDevice }).device?.queue;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const stop = (err?: Error) => { done = true; o.signal?.removeEventListener("abort", onAbort); if (err) reject(err); else resolve(); };
      const onAbort = () => stop(abortError());
      o.signal?.addEventListener("abort", onAbort);
      tracer.addEventListener("complete", () => stop());
      denoiser.addEventListener("error", (e: { error?: unknown }) => stop(new Error(`降噪失败：${String(e.error ?? "未知原因")}`)));
      (async () => {
        // “complete”是在 renderSample() 里面触发的，所以每次调用后都要看一眼是否已经结束，免得在释放后又排一批
        while (!done) {
          tracer.renderSample();
          if (queue) await queue.onSubmittedWorkDone(); else await new Promise(r => setTimeout(r, 0));
        }
      })().catch(err => stop(err as Error));
    });
    // 再画一帧，紧接着读画布：WebGPU 画布的内容只在画完的这一刻读得到
    tracer.renderSample();
    const blob = await new Promise<Blob | null>(r => o.canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("读不出渲染结果");
    return blob;
  } finally {
    pt?.dispose();
    cleanup();
    renderer.dispose();
  }
}

const abortError = () => new DOMException("已停止", "AbortError");

/** 和 3D 浏览里看到的一样的房子、家具、灯光，去掉只为实时渲染补的假阴影 */
async function buildScene(shot: Shot) {
  // 内置颜色按标准 sRGB 理解：同机位对比，旧方式（实时浏览用的）在路径追踪里木色发白，胡桃木像浅橡木
  const m = createMaterials({ trueColor: true });
  const b = buildHouse(shot.house, m);
  const scene = new THREE.Scene();
  const walls = b.walls(shot.orbit);
  scene.add(b.fixed, b.items, walls);
  if (!shot.orbit) scene.add(b.ceil);
  // 鸟瞰时藏起来的东西（落地窗帘、吊灯）、被吊灯替掉的吸顶灯：直接拿掉，路径追踪不一定认 visible
  if (shot.orbit) for (const o of b.orbitHidden) o.removeFromParent();
  // 家具脚下的暗影贴片、墙角暗边是给实时渲染补的“假阴影”，路径追踪自己会算，留着会重复变暗
  const drop: THREE.Object3D[] = [];
  scene.traverse(o => { if (!o.visible || o.userData.blob || (o as THREE.Mesh).material === m.mat.edge) drop.push(o); });
  for (const o of drop) o.removeFromParent();

  // 阳光：和 viewer.ts 一样从西南方高处照进来
  const [cx, cz] = b.center;
  const sun = new THREE.DirectionalLight(0xffeed6, (shot.orbit ? 1.35 : 2.9) * Math.PI);
  sun.position.set(cx - 7.6, 13, cz + 14);
  sun.target.position.set(cx, 0, cz);
  scene.add(sun, sun.target);
  // 天光：晴天天空 HDRI。站在屋里时窗外看到的就是它；鸟瞰时背景用浅灰，不然房子像飘在天上
  const sky = await new HDRLoader().loadAsync(ASSETS + "sky_1k.hdr");
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = sky;
  scene.background = shot.orbit ? new THREE.Color("#E6E8E3") : sky;
  return {
    scene,
    dispose: () => { for (const g of [b.fixed, b.items, b.ceil, walls]) disposeTree(g); sky.dispose(); },
  };
}

function stillCamera(shot: Shot, aspect: number) {
  const c = new THREE.PerspectiveCamera(shot.fov, aspect, 0.03, 200);
  c.position.fromArray(shot.position);
  c.quaternion.fromArray(shot.quaternion);
  c.updateMatrixWorld();
  return c;
}
/** 全景：站在原地、眼睛高度，只保留水平朝向，地平线是平的 */
function panoCamera(shot: Shot) {
  const c = new EquirectCamera();
  c.position.fromArray(shot.position);
  // 全景图的正中对着相机的 +x 方向，3D 浏览的相机朝 -z 看：多转 90° 才能让正中是你面朝的方向
  c.rotation.set(0, shot.yaw + Math.PI / 2, 0);
  c.updateMatrixWorld();
  return c;
}

