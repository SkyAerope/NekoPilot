import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { copyFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import sharp from "sharp";

const isWatch = process.argv.includes("--watch");

// Chrome 扩展图标只支持 PNG（不支持 SVG），需在构建期把 icon.svg 渲染为多尺寸 PNG。
const ICON_SIZES = [16, 32, 48, 128];

export default defineConfig({
  // 编译期常量：仅在 watch（开发）模式为 true。生产构建为 false，
  // 使 background 中的自动热重载逻辑被 tree-shaking 完全移除，零运行时成本。
  define: {
    __DEV_RELOAD__: JSON.stringify(isWatch),
  },
  plugins: [
    react(),
    {
      name: "copy-manifest",
      async closeBundle() {
        const distDir = resolve(__dirname, "dist");
        if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
        copyFileSync(
          resolve(__dirname, "manifest.json"),
          resolve(distDir, "manifest.json")
        );
        const iconsDir = resolve(distDir, "icons");
        if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });
        // 从 SVG 渲染各尺寸 PNG 到 dist/icons/。
        const svgPath = resolve(__dirname, "icons", "icon.svg");
        if (existsSync(svgPath)) {
          const svg = readFileSync(svgPath);
          await Promise.all(
            ICON_SIZES.map((size) =>
              sharp(svg)
                .resize(size, size)
                .png()
                .toFile(resolve(iconsDir, `icon-${size}.png`))
            )
          );
        }
        // Write a reload stamp so the background script can auto-reload the
        // extension during `vite build --watch`.
        if (isWatch) {
          writeFileSync(
            resolve(distDir, "reload.json"),
            JSON.stringify({ ts: Date.now() })
          );
        }
      },
    },
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
        options: resolve(__dirname, "options.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
