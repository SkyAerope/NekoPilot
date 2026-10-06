import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { screenshotData } from "../helpers/harness";

test("截图以 Blob 保存，引用可复用且读取保持原始字节", async ({ page }) => {
  // Given：真实浏览器源和 IndexedDB，不模拟数据库。
  await page.route("**/asset-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>storage</title>" }),
  );
  await page.goto("/asset-test");
  const code = ts.transpileModule(
    readFileSync("src/shared/assets.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  // When：保存同一截图两次，并读取持久化的 Blob。
  const result = await page.evaluate(
    async ({ code, data }) => {
      const api: typeof import("../../src/shared/assets") = new Function(
        "exports",
        `${code}; return exports;`,
      )({});
      const first = await api.storeScreenshot({ data, mime: "image/png" });
      const second = await api.storeScreenshot({ data, mime: "image/png" });
      const blob = await api.readAsset(first.id);
      return {
        first,
        second,
        bytes: blob
          ? Array.from(new Uint8Array(await blob.arrayBuffer()))
          : null,
        missing: await api.readAsset("missing"),
      };
    },
    { code, data: screenshotData },
  );
  // Then：引用不含正文，数据库中的文件字节及尺寸正确。
  expect(result.first).toEqual(result.second);
  expect(result.first).toMatchObject({
    mime: "image/png",
    width: 1,
    height: 1,
  });
  expect(result.first).not.toHaveProperty("data");
  expect(result.bytes).toEqual(
    Array.from(Buffer.from(screenshotData, "base64")),
  );
  expect(result.missing).toBeNull();
});

test("历史迁移与请求物化保留图片字节，不污染引用历史", async ({ page }) => {
  // Given：旧截图历史和真实数据库。
  await page.route("**/asset-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>history</title>" }),
  );
  await page.goto("/asset-test");
  const compile = (path: string) =>
    ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
  const result = await page.evaluate(
    async ({ assetsCode, historyCode, data }) => {
      const assets: typeof import("../../src/shared/assets") = new Function(
        "exports",
        `${assetsCode}; return exports;`,
      )({});
      const history: typeof import("../../src/agent/screenshot-history") =
        new Function("exports", "require", `${historyCode}; return exports;`)(
          {},
          () => assets,
        );
      // When：迁移后生成请求副本。
      const migrated = await history.migrateScreenshotHistory([
        {
          role: "user",
          content: [
            { type: "text", text: "[screenshot result]" },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${data}` },
            },
          ],
        },
      ]);
      const materialized = await history.materializeScreenshots(migrated);
      const repeated = await history.migrateScreenshotHistory(migrated);
      const missing = await history.materializeScreenshots([
        {
          role: "user",
          content: [
            {
              type: "screenshot",
              screenshot: { id: "missing", mime: "image/png", size: 1 },
            },
          ],
        },
      ]);
      return { migrated, materialized, repeated, missing };
    },
    {
      assetsCode: compile("src/shared/assets.ts"),
      historyCode: compile("src/agent/screenshot-history.ts"),
      data: screenshotData,
    },
  );
  // Then：引用稳定，只有请求副本包含正确 Base64，缺失文件不会发送无效图片。
  expect(JSON.stringify(result.migrated)).not.toContain(screenshotData);
  expect(result.repeated).toEqual(result.migrated);
  expect(result.materialized[0]?.content).toEqual([
    { type: "text", text: "[screenshot result]" },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${screenshotData}` },
    },
  ]);
  expect(result.missing[0]?.content).toMatchObject([{ type: "text" }]);
});

test("写事务被中止时不发布截图引用", async ({ page }) => {
  // Given：真实写事务在请求提交前中止。
  await page.route("**/asset-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>abort</title>" }),
  );
  await page.goto("/asset-test");
  const code = ts.transpileModule(
    readFileSync("src/shared/assets.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  // When：尝试保存截图。
  const result = await page.evaluate(
    async ({ code, data }) => {
      const api: typeof import("../../src/shared/assets") = new Function(
        "exports",
        `${code}; return exports;`,
      )({});
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        value: unknown,
        key?: IDBValidKey,
      ) {
        const request = original.call(this, value, key);
        this.transaction.abort();
        return request;
      };
      try {
        await api.storeScreenshot({ data, mime: "image/png" });
        return "published";
      } catch (error) {
        return error instanceof Error ? error.name : "unknown";
      } finally {
        IDBObjectStore.prototype.put = original;
      }
    },
    { code, data: screenshotData },
  );
  // Then：显式失败而不是产生悬空引用。
  expect(result).toBe("AssetStorageError");
});
