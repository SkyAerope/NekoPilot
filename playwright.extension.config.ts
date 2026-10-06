import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/extension",
  outputDir: "./artifacts/extension-tests",
  workers: 1,
  timeout: 90_000,
  reporter: "list",
});
