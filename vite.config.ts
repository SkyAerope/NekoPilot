import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { copyFileSync, mkdirSync, existsSync } from "fs";

export default defineConfig({
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
