import { expect, test } from "@playwright/test";
import { installHarness } from "../helpers/harness";

for (const theme of ["light", "dark"] as const) {
  test(`高亮模块延迟时工具详情与复制立即可用，增强后高度不变：${theme}`, async ({
    page,
  }, testInfo) => {
    const code = "const value = 42;\nconsole.log(value);";
    const result = { value: 42 };
    await installHarness(page, {
      themeMode: theme,
      chatLogs: [
        {
          id: 1,
          type: "tool_call",
          toolName: "execute_js",
          toolCallId: "immediate-js",
          content: JSON.stringify({ code }),
          toolResult: JSON.stringify(result),
          toolSuccess: true,
          timestamp: 1,
        },
      ],
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.copied = text;
          },
        },
      });
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      /\/chunks\/(?:tool-details|code-block|code-highlighter)[^/]*\.js$/,
      async (route) => {
        await gate;
        await route.continue();
      },
    );
    try {
      await page.goto("/sidepanel.html");
      await page.getByRole("button", { name: /执行 JS 代码/ }).click();
      await expect(
        page.getByRole("tablist", { name: "工具详情" }),
      ).toBeVisible();
      await expect(page.locator("code:visible")).toHaveText(
        JSON.stringify(result, null, 2),
      );
      await page.getByRole("button", { name: "复制结果", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-copied",
        JSON.stringify(result, null, 2),
      );
      await page.getByRole("tab", { name: "代码", exact: true }).click();
      await expect(page.locator("code:visible")).toHaveText(code);
      await page.getByRole("button", { name: "复制代码", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-copied", code);
      await expect(
        page.getByText("正在加载详情…", { exact: true }),
      ).toHaveCount(0);
      await expect(page.locator("pre.shiki:visible")).toHaveCount(0);
      const before = await page
        .locator("pre:visible")
        .evaluate((element) => element.getBoundingClientRect().height);
      await page.screenshot({
        path: testInfo.outputPath("plain.png"),
        animations: "disabled",
      });
      release();
      await expect(page.locator("pre.shiki:visible")).toBeVisible();
      await expect(page.locator("code:visible")).toHaveText(code);
      const after = await page
        .locator("pre:visible")
        .evaluate((element) => element.getBoundingClientRect().height);
      expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: testInfo.outputPath("highlighted.png"),
        animations: "disabled",
      });
    } finally {
      release();
    }
  });
}

test("高亮模块加载失败时保留工具参数与复制操作", async ({ page }) => {
  await installHarness(page);
  await page.route(
    /\/chunks\/(?:tool-details|code-block|code-highlighter)[^/]*\.js$/,
    (route) => route.abort(),
  );
  await page.goto("/sidepanel.html");
  await page.evaluate(() =>
    window.__harness.emit({
      type: "tool_call",
      data: {
        id: "plain-click",
        name: "click",
        args: '{"selector":"#submit"}',
      },
    }),
  );
  await page.getByRole("button", { name: /点击/ }).click();
  await expect(page.locator("code:visible")).toContainText("#submit");
  await expect(
    page.getByRole("button", { name: "复制参数", exact: true }),
  ).toBeEnabled();
});
