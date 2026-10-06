import { expect, test } from "@playwright/test";
import { installHarness } from "../helpers/harness";
import sharp from "sharp";

test("附件单独发送时保存真实文件引用，重试保留引用", async ({ page }) => {
  // Given
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("attachment body 独立内容"),
    });
  // When
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  // Then
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.filter((m) => m.type === "agent:start")
            .length,
      ),
    )
    .toBe(1);
  const refs = await page.evaluate(
    () =>
      window.__harness.messages.find((m) => m.type === "agent:start")?.payload
        ?.attachments,
  );
  expect(refs).toEqual([
    expect.objectContaining({
      kind: "text",
      name: "notes.md",
      asset: expect.objectContaining({
        mime: "text/markdown",
        size: Buffer.byteLength("attachment body 独立内容"),
      }),
    }),
  ]);
  await page.evaluate(() => window.__harness.emit({ type: "done", data: "" }));
  await page.getByRole("button", { name: "重试", exact: true }).first().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.filter((m) => m.type === "agent:start")
            .length,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(
      () =>
        window.__harness.messages.filter((m) => m.type === "agent:start")[1]
          ?.payload?.attachments,
    ),
  ).toEqual(refs);
});

test("不支持的附件明确拒绝且不发送", async ({ page }) => {
  // Given
  await installHarness(page);
  await page.goto("/sidepanel.html");
  // When
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF"),
    });
  // Then
  await expect(page.getByRole("alert")).toContainText("report.pdf");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeDisabled();
});

test("图片附件保留原始字节而非只传文件名", async ({ page }) => {
  // Given
  await installHarness(page);
  await page.goto("/sidepanel.html");
  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: image });
  await page
    .getByRole("textbox", { name: "任务内容", exact: true })
    .fill("识别图片");
  // When
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  // Then
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.find((m) => m.type === "agent:start")
            ?.payload?.attachments,
      ),
    )
    .toEqual([
      expect.objectContaining({
        kind: "image",
        name: "pixel.png",
        asset: expect.objectContaining({
          mime: "image/png",
          size: image.length,
        }),
      }),
    ]);
});

test("后台拒绝附件发送时保留草稿和文件", async ({ page }) => {
  // Given
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await page
    .getByRole("textbox", { name: "任务内容", exact: true })
    .fill("draft instruction");
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("draft file"),
    });
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage;
    Object.defineProperty(chrome.runtime, "sendMessage", {
      value: (
        message: { type: string },
        callback: (response: unknown) => void,
      ) => {
        if (message.type === "agent:start") {
          callback({ error: "fixture rejected" });
          return;
        }
        Reflect.apply(original, chrome.runtime, [message, callback]);
      },
    });
  });
  // When
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  // Then
  await expect(page.getByRole("alert")).toContainText("fixture rejected");
  await expect(
    page.getByRole("textbox", { name: "任务内容", exact: true }),
  ).toHaveValue("draft instruction");
  await expect(
    page.getByRole("button", { name: "移除 notes.txt", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toHaveCount(0);
});

for (const width of [375, 768, 1280]) {
  test(`附件名称与错误反馈在 ${width}px 下无溢出`, async ({
    page,
  }, testInfo) => {
    // Given
    await installHarness(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/sidepanel.html");
    const filename = "中文附件名称及非常长的正文说明_".repeat(4) + ".md";
    await page
      .locator('input[type="file"]')
      .last()
      .setInputFiles({
        name: filename,
        mimeType: "text/markdown",
        buffer: Buffer.from("content"),
      });
    // When
    await page.getByRole("button", { name: "发送消息", exact: true }).focus();
    // Then
    await expect(
      page.getByRole("button", { name: "发送消息", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`attachments-${width}.png`),
    });
  });
}
