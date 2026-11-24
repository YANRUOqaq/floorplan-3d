import { defineConfig } from "vitest/config";

// base：GitHub Pages 把项目放在 https://<用户名>.github.io/<仓库名>/ 下，资源路径要带上仓库名。
// 本地开发（npm run dev）时用根路径；npm run preview 预览打包结果时和线上一样带仓库名。
export default defineConfig(({ command, isPreview }) => ({
  base: command === "build" || isPreview ? "/floorplan-3d/" : "/",
  build: {
    // 两个页面：编辑器（index.html）和家具库（gallery.html）
    rollupOptions: { input: { main: "index.html", gallery: "gallery.html" } },
    // three.js 本身约 600 kB（gzip 后 200 kB），打开页面就要用到 3D，拆分也省不下首屏流量
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
}));
