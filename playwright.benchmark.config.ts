import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/benchmarks",
  outputDir: "./artifacts/screenshot-decode",
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  },
  webServer: {
    command: "pnpm preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173/sidepanel.html",
    reuseExistingServer: !process.env.CI,
  },
});
