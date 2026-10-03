import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import ts from "typescript";

const executorCode = ts.transpileModule(
  readFileSync("src/tools/executor.ts", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  },
).outputText;

test.use({ viewport: { width: 1001, height: 701 }, deviceScaleFactor: 2 });

for (const mode of ["claude46", "custom", "off"] as const) {
  test(`无裁剪截图与坐标点击一致：${mode}`, async ({ page }) => {
    await page.setContent(`
      <style>body { margin: 0; height: 2500px; background: white }
      button { position: fixed; left: 200px; top: 100px; width: 100px; height: 100px;
        border: 0; padding: 0; background: rgb(0, 128, 0) }</style>
      <button onclick="this.dataset.clicked = 'true'">目标</button>
    `);
    const cdp = await page.context().newCDPSession(page);
    const captures: Record<string, unknown>[] = [];
    await page.exposeFunction(
      "sendScreenshotCommand",
      async (method: string, params?: Record<string, unknown>) => {
        if (method === "Page.captureScreenshot") captures.push(params!);
        return cdp.send(method as any, params);
      },
    );
    const result = await page.evaluate(
      async ({ code, mode }) => {
        const exports: any = {};
        new Function("exports", "require", code)(exports, () => ({
          JsSandbox: class {},
        }));
        const executor = new exports.ToolExecutor({
          send: (window as any).sendScreenshotCommand,
        });
        executor.configureScreenshotScaling(mode, 400, 100001);
        const shot = await executor.execute("screenshot", {});
        const header = Uint8Array.from(
          atob(shot.data.data.slice(0, 32)),
          (character) => character.charCodeAt(0),
        );
        const nativeScale =
          new DataView(header.buffer).getUint32(16) / innerWidth;
        const scale =
          mode === "off"
            ? nativeScale
            : mode === "custom"
              ? Math.min(
                  400 / innerWidth,
                  Math.sqrt(100001 / (innerWidth * innerHeight)),
                )
              : 1;
        const click = await executor.execute("click", {
          x: 250 * scale,
          y: 150 * scale,
        });
        window.scrollTo(0, 900);
        const scrolled = await executor.execute("screenshot", {});
        return {
          shot,
          scrolled,
          click,
          scale,
          width: innerWidth,
          height: innerHeight,
        };
      },
      { code: executorCode, mode },
    );

    expect(result.shot.success).toBe(true);
    expect(result.scrolled.success).toBe(true);
    expect(result.click.success).toBe(true);
    await expect(page.locator("button")).toHaveAttribute(
      "data-clicked",
      "true",
    );
    expect(captures).toEqual([{ format: "png" }, { format: "png" }]);
    for (const shot of [result.shot, result.scrolled]) {
      const buffer = Buffer.from(shot.data.data, "base64");
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(Math.floor(result.width * result.scale));
      expect(metadata.height).toBe(Math.floor(result.height * result.scale));
      const { data } = await sharp(buffer)
        .extract({
          left: Math.round(250 * result.scale),
          top: Math.round(170 * result.scale),
          width: 1,
          height: 1,
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(Array.from(data)).toEqual([0, 128, 0]);
      if (mode === "custom") {
        expect(metadata.width! * metadata.height!).toBeLessThanOrEqual(100001);
        expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(
          400,
        );
      }
    }
  });
}

test("极小像素预算仍生成有效 PNG", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await page.exposeFunction(
    "sendScreenshotCommand",
    (method: string, params?: any) => cdp.send(method as any, params),
  );
  const result = await page.evaluate(async (code) => {
    const exports: any = {};
    new Function("exports", "require", code)(exports, () => ({
      JsSandbox: class {},
    }));
    const executor = new exports.ToolExecutor({
      send: (window as any).sendScreenshotCommand,
    });
    executor.configureScreenshotScaling("custom", 0, 1);
    return executor.execute("screenshot", {});
  }, executorCode);
  expect(result.success).toBe(true);
  const metadata = await sharp(
    Buffer.from(result.data.data, "base64"),
  ).metadata();
  expect([metadata.width, metadata.height]).toEqual([1, 1]);
});
