import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { emit, installHarness } from "../helpers/harness";

async function createLargeScreenshot() {
  const pixels = Buffer.alloc(1920 * 1080 * 3);
  let seed = 12345;
  for (let index = 0; index < pixels.length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    pixels[index] = seed & 255;
  }
  return sharp(pixels, {
    raw: { width: 1920, height: 1080, channels: 3 },
  })
    .png()
    .toBuffer();
}

test("大截图重新展开时不重新等待图片或重复淡入", async ({ page }, testInfo) => {
  const png = await createLargeScreenshot();
  await installHarness(page, {
    chatLogs: [
      {
        id: 1,
        type: "tool_call",
        toolName: "screenshot",
        content: "{}",
        timestamp: 1,
        screenshotData: png.toString("base64"),
        screenshotMime: "image/png",
        toolResult: "done",
        toolSuccess: true,
      },
    ],
  });
  await page.goto("/sidepanel.html");
  const trigger = page.getByRole("button", { name: /Take screenshot/ });
  const sampleOpening = () =>
    trigger.evaluate(async (element) => {
      const frames: {
        time: number;
        height: number;
        imageOpacity: number;
        loaded: boolean;
        loading: boolean;
      }[] = [];
      const start = performance.now();
      if (element instanceof HTMLElement) element.click();
      for (let frame = 0; frame < 35; frame++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        const image = document.querySelector('img[alt="浏览器截图"]');
        const preview = document.querySelector(
          '[data-slot="screenshot-preview"]',
        );
        frames.push({
          time: performance.now() - start,
          height: preview?.getBoundingClientRect().height ?? 0,
          imageOpacity: image ? Number(getComputedStyle(image).opacity) : 0,
          loaded:
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0,
          loading: preview?.textContent?.includes("正在加载截图") ?? false,
        });
      }
      return frames;
    });
  const first = await sampleOpening();
  const firstHeights = first
    .filter((frame) => frame.height > 0)
    .map((frame) => frame.height);
  expect(Math.max(...firstHeights) - Math.min(...firstHeights)).toBeLessThan(1);
  await expect(page.getByAltText("浏览器截图")).toHaveCSS("opacity", "1");
  await trigger.click();
  await expect(page.getByAltText("浏览器截图")).toBeHidden();
  const reopened = await sampleOpening();
  await testInfo.attach("opening-frames", {
    body: JSON.stringify({ bytes: png.length, first, reopened }, null, 2),
    contentType: "application/json",
  });
  const visibleFrames = reopened.filter((frame) => frame.height > 0);
  expect(visibleFrames.length).toBeGreaterThan(0);
  expect(
    visibleFrames.every((frame) => !frame.loading && frame.imageOpacity === 1),
  ).toBe(true);
});

test("移入大截图标题时预解码，首次展开不再等待图片", async ({ page }) => {
  const png = await createLargeScreenshot();
  await page.addInitScript(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
      return decode.call(this).then(() => {
        document.documentElement.dataset.imageDecoded = "true";
      });
    };
  });
  await installHarness(page, {
    chatLogs: [
      {
        id: 1,
        type: "tool_call",
        toolName: "screenshot",
        content: "{}",
        timestamp: 1,
        screenshotData: png.toString("base64"),
        screenshotMime: "image/png",
        toolResult: "done",
        toolSuccess: true,
      },
    ],
  });
  await page.goto("/sidepanel.html");
  const trigger = page.getByRole("button", { name: /Take screenshot/ });
  await trigger.hover();
  await expect(page.locator("html")).toHaveAttribute(
    "data-image-decoded",
    "true",
  );
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  const firstFrame = await trigger.evaluate(async (element) => {
    if (element instanceof HTMLElement) element.click();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const image = document.querySelector('img[alt="浏览器截图"]');
    return {
      opacity: image ? getComputedStyle(image).opacity : "0",
      loading:
        document
          .querySelector('[data-slot="screenshot-preview"]')
          ?.textContent?.includes("正在加载截图") ?? true,
    };
  });
  expect(firstFrame).toEqual({ opacity: "1", loading: false });
});

test("PNG 截图打开时预留比例，不等待代码详情模块", async ({ page }) => {
  const png = await sharp({
    create: { width: 640, height: 320, channels: 3, background: "#74aaff" },
  })
    .png()
    .toBuffer();
  await installHarness(page, {
    chatLogs: [
      {
        id: 1,
        type: "tool_call",
        toolName: "screenshot",
        content: "{}",
        timestamp: 1,
        screenshotData: png.toString("base64"),
        screenshotMime: "image/png",
        toolResult: "done",
        toolSuccess: true,
      },
    ],
  });
  await page.route("**/chunks/tool-details-*.js", (route) => route.abort());
  await page.goto("/sidepanel.html");
  await page.getByRole("button", { name: /Take screenshot/ }).click();
  const image = page.getByAltText("浏览器截图");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("width", "640");
  await expect(image).toHaveAttribute("height", "320");
  await expect(page.getByText("正在加载详情…", { exact: true })).toHaveCount(0);
  const box = await image.boundingBox();
  expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(2, 1);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`截图比例未知时图片到达的高度变化遵守动态效果设置：${reducedMotion}`, async ({
    page,
  }, testInfo) => {
    const jpeg = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "#74aaff" },
    })
      .jpeg()
      .toBuffer();
    await page.emulateMedia({ reducedMotion });
    await installHarness(page);
    await page.goto("/sidepanel.html");
    await emit(page, "tool_call", {
      id: "late-shot",
      name: "screenshot",
      args: "{}",
    });
    await page.getByRole("button", { name: /Take screenshot/ }).click();
    await expect(page.getByText("正在截屏…", { exact: true })).toBeVisible();
    const preview = page.locator('[data-slot="screenshot-preview"]');
    await expect(preview).toBeVisible();
    const heights = await preview.evaluate(async (element, data) => {
      const heights = [element.getBoundingClientRect().height];
      window.__harness.emit({
        type: "tool_result",
        data: {
          id: "late-shot",
          name: "screenshot",
          result: { success: true, data, mimeType: "image/jpeg" },
        },
      });
      for (let frame = 0; frame < 40; frame++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        heights.push(element.getBoundingClientRect().height);
      }
      return heights;
    }, jpeg.toString("base64"));
    await expect(page.getByAltText("浏览器截图")).toBeVisible();
    const first = heights[0] ?? 0;
    const last = heights.at(-1) ?? 0;
    expect(last).toBeGreaterThan(first + 50);
    const intermediate = heights.some(
      (height) => height > first + 2 && height < last - 2,
    );
    expect(intermediate).toBe(reducedMotion === "no-preference");
    await page.screenshot({
      path: testInfo.outputPath("screenshot-loaded.png"),
      animations: "disabled",
    });
  });
}
