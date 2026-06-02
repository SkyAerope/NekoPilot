import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { copyFileSync, mkdirSync, existsSync, writeFileSync } from "fs";

const isWatch = process.argv.includes("--watch");

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
      closeBundle() {
        const distDir = resolve(__dirname, "dist");
        if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
        copyFileSync(
          resolve(__dirname, "manifest.json"),
          resolve(distDir, "manifest.json")
        );
        const iconsDir = resolve(distDir, "icons");
        if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });
        const iconSrc = resolve(__dirname, "icons");
        if (existsSync(iconSrc)) {
          for (const f of ["icon.svg"]) {
            const src = resolve(iconSrc, f);
            if (existsSync(src)) copyFileSync(src, resolve(iconsDir, f));
          }
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
