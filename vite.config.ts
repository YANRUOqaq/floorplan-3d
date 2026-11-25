/// <reference types="node" />
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * three-gpu-pathtracer（出效果图用）里有个文件叫 aux.wgsl.js。AUX 是 Windows 的保留设备名，
 * Vite 的打包器（rolldown）在 Windows 上解析不到它，开发服务器和打包都会报 “Could not resolve './nodes/aux.wgsl.js'”。
 * 这里把对它的导入换成同目录下的另一个名字，内容照原文件读。Linux、macOS 上没有这个问题（GitHub Actions 的构建跑在 Linux 上），插件也不影响结果。
 */
const AUX = /[\\/]three-gpu-pathtracer[\\/]src[\\/]webgpu[\\/]nodes[\\/]aux\.wgsl\.js$/;
const pathtracerAuxOnWindows: Plugin = {
  name: "pathtracer-aux-on-windows",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer || !source.endsWith("aux.wgsl.js")) return null;
    const p = path.resolve(path.dirname(importer.split("?")[0]), source);
    return AUX.test(p) ? p.replace(/aux\.wgsl\.js$/, "aux-renamed.wgsl.js") : null;
  },
  load(id) {
    return id.endsWith("aux-renamed.wgsl.js") ? readFileSync(id.replace(/aux-renamed\.wgsl\.js$/, "aux.wgsl.js"), "utf8") : null;
  },
};

// base：GitHub Pages 把项目放在 https://<用户名>.github.io/<仓库名>/ 下，资源路径要带上仓库名。
// 本地开发（npm run dev）时用根路径；npm run preview 预览打包结果时和线上一样带仓库名。
export default defineConfig(({ command, isPreview }) => ({
  base: command === "build" || isPreview ? "/floorplan-3d/" : "/",
  plugins: [pathtracerAuxOnWindows],
  optimizeDeps: {
    // 出效果图的这几个库是点按钮时才加载的，开发服务器启动时扫描不到。不提前列出来，第一次点按钮时它们会被分开预构建，
    // three/webgpu 和 three-mesh-bvh 的 WebGPU 部分各带一份 three.js 节点系统，生成的着色器出错（2026-11-25 实测）
    include: ["three/webgpu", "three/tsl", "three-gpu-pathtracer/webgpu", "three-mesh-bvh/webgpu", "three-mesh-bvh/worker", "oidn-webgpu"],
    rolldownOptions: { plugins: [pathtracerAuxOnWindows] },
  },
  build: {
    // 两个页面：编辑器（index.html）和家具库（gallery.html）
    rollupOptions: { input: { main: "index.html", gallery: "gallery.html" } },
    // three.js 本身约 600 kB（gzip 后 200 kB），打开页面就要用到 3D，拆分也省不下首屏流量。
    // 出效果图的路径追踪（WebGPU 版 three.js、路径追踪、降噪）约 1.2 MB（gzip 后 330 kB），只在点“开始”时才加载
    chunkSizeWarningLimit: 1300,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
}));
