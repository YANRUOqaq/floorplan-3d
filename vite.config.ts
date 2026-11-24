import { defineConfig } from "vitest/config";

// base：GitHub Pages 把项目放在 https://<用户名>.github.io/<仓库名>/ 下，资源路径要带上仓库名。
// 本地开发（npm run dev）时用根路径。
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/floorplan-3d/" : "/",
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
}));
