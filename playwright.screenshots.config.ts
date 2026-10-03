import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

export default defineConfig({
  ...config,
  testDir: "./tests/manual",
  fullyParallel: false,
  workers: 1,
});
