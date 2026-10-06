import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { cpus, platform } from "node:os";
import sharp from "sharp";
import ts from "typescript";

const cases = [
  { name: "default-page", width: 1440, height: 798, noise: false },
  { name: "native-page", width: 1920, height: 1080, noise: false },
  { name: "native-noise", width: 1920, height: 1080, noise: true },
  { name: "hidpi-page", width: 3840, height: 2160, noise: false },
];

for (const fixture of cases) {
  test(`IndexedDB 读取与图片解码：${fixture.name}`, async ({
    page,
    browser,
  }, testInfo) => {
    // Given：文本密集图片与高熵压力样本，使用实际生产存储模块。
    const pixels = Buffer.alloc(fixture.width * fixture.height * 3);
    let seed = 12345;
    for (let index = 0; index < pixels.length; index++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[index] = seed & 255;
    }
    const png = fixture.noise
      ? await sharp(pixels, {
          raw: { width: fixture.width, height: fixture.height, channels: 3 },
        })
          .png()
          .toBuffer()
      : await sharp(
          Buffer.from(
            `<svg width="${fixture.width}" height="${fixture.height}"><rect width="100%" height="100%" fill="white"/>${Array.from({ length: 60 }, (_, row) => `<text x="24" y="${30 + row * 32}" font-size="18" fill="#333">NekoPilot screenshot fixture ${row}: browser automation, attachments, persistent history</text>`).join("")}</svg>`,
          ),
        )
          .png()
          .toBuffer();
    await page.route("**/decode-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>decode</title>",
      }),
    );
    await page.goto("/decode-test");
    const code = ts.transpileModule(
      readFileSync("src/shared/assets.ts", "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    // When：每轮新 Image 与新 URL；分别测量数据库读取、首次解码与保留资源再次解码。
    const samples = await page.evaluate(
      async ({ code, data }) => {
        const api: typeof import("../../src/shared/assets") = new Function(
          "exports",
          `${code}; return exports;`,
        )({});
        const ref = await api.storeScreenshot({ data, mime: "image/png" });
        const samples: {
          readMs: number;
          urlMs: number;
          decodeMs: number;
          retainedMs: number;
        }[] = [];
        for (let sample = 0; sample < 35; sample++) {
          const start = performance.now();
          const blob = await api.readAsset(ref.id);
          if (!blob) throw new Error("Missing benchmark fixture");
          const readDone = performance.now();
          const url = URL.createObjectURL(blob);
          const urlDone = performance.now();
          const image = new Image();
          image.decoding = "async";
          image.src = url;
          await image.decode();
          const decoded = performance.now();
          await image.decode();
          const retained = performance.now();
          URL.revokeObjectURL(url);
          if (sample >= 5)
            samples.push({
              readMs: readDone - start,
              urlMs: urlDone - readDone,
              decodeMs: decoded - urlDone,
              retainedMs: retained - decoded,
            });
        }
        return samples;
      },
      { code, data: png.toString("base64") },
    );
    // Then：记录分位数，不用机器相关阈值把性能测试变成不稳定门禁。
    const summarize = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      };
    };
    const report = {
      fixture,
      bytes: png.length,
      browser: browser.version(),
      platform: platform(),
      cpu: cpus()[0]?.model,
      cacheConditions:
        "数据库已打开；5 次预热后 30 次新 Image/新 Blob URL；不宣称磁盘或进程冷启动。",
      readMs: summarize(samples.map((s) => s.readMs)),
      urlMs: summarize(samples.map((s) => s.urlMs)),
      decodeMs: summarize(samples.map((s) => s.decodeMs)),
      retainedMs: summarize(samples.map((s) => s.retainedMs)),
      samples,
    };
    console.log(JSON.stringify({ ...report, samples: undefined }));
    await testInfo.attach("decode-timings", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    await writeFile(
      testInfo.outputPath("decode-timings.json"),
      JSON.stringify(report, null, 2),
    );
    expect(samples).toHaveLength(30);
  });
}
