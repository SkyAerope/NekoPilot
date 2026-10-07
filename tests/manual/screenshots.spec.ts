import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { emit, installHarness } from "../helpers/harness";

test("暗色审批展示和设置布局", async ({ page }) => {
  await installHarness(page, { themeMode: "dark" });
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "js-1",
    name: "execute_js",
    args: JSON.stringify({
      description: "统计页面中的订单金额",
      code: "const total = [25, 30, 45].reduce((sum, price) => sum + price, 0);\nconsole.log(total);",
    }),
    needsPermission: true,
  });
  await page.getByRole("button", { name: /执行 JS 代码/ }).click();
  await expect(
    page.getByRole("button", { name: "允许", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/sidepanel-approval-dark.png" });
  await page.goto("/options.html");
  await expect(
    page.getByRole("heading", { name: "NekoPilot 设置" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 900 });
  await mkdir("artifacts/ui", { recursive: true });
  await page.screenshot({
    path: "artifacts/ui/options-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() =>
    (window.chrome.storage.local.set as unknown as (values: object) => void)({
      themeMode: "light",
    }),
  );
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.screenshot({
    path: "artifacts/ui/options-light.png",
    fullPage: true,
    animations: "disabled",
  });
});
