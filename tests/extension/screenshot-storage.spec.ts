import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { assetKeys, seedOrphan } from "../helpers/asset-database";

for (const provider of ["openai", "anthropic"] as const) {
  test(`真实扩展截图跨后台与侧边栏使用 IndexedDB：${provider}`, async ({}, testInfo) => {
    // Given：独立浏览器配置、真实扩展后台、HTTP 级模型替身。
    const requests: string[] = [];
    let count = 0;
    const server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Headers", "*");
      if (request.method === "OPTIONS") {
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("Content-Type", "text/html");
        response.end(
          "<title>fixture</title><h1>NekoPilot screenshot storage</h1>",
        );
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        requests.push(body);
        response.setHeader("Content-Type", "text/event-stream");
        const events: Record<string, unknown>[] =
          provider === "openai"
            ? count++ === 0
              ? [
                  {
                    choices: [
                      {
                        delta: {
                          tool_calls: Array.from({ length: 3 }, (_, index) => ({
                            index,
                            id: `shot-${index + 1}`,
                            type: "function",
                            function: { name: "screenshot", arguments: "{}" },
                          })),
                        },
                      },
                    ],
                  },
                ]
              : [{ choices: [{ delta: { content: "completed" } }] }]
            : count++ === 0
              ? [
                  ...Array.from({ length: 3 }, (_, index) => [
                    {
                      type: "content_block_start",
                      index,
                      content_block: {
                        type: "tool_use",
                        id: `shot-${index + 1}`,
                        name: "screenshot",
                        input: {},
                      },
                    },
                    {
                      type: "content_block_delta",
                      index,
                      delta: { type: "input_json_delta", partial_json: "{}" },
                    },
                    { type: "content_block_stop", index },
                  ]).flat(),
                  { type: "message_stop" },
                ]
              : [
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "completed" },
                  },
                  { type: "content_block_stop", index: 0 },
                  { type: "message_stop" },
                ];
        response.end(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const profile = await mkdtemp(join(tmpdir(), "nekopilot-idb-"));
    const context = await chromium.launchPersistentContext(profile, {
      channel: process.env.EXTENSION_CHANNEL || "msedge",
      headless: true,
      args: ["--enable-unsafe-extension-debugging"],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    try {
      const browser = context.browser();
      if (!browser) throw new Error("Browser session unavailable");
      const session = await browser.newBrowserCDPSession();
      const { id } = await session.send("Extensions.loadUnpacked", {
        path: resolve("dist"),
      });
      const target = await context.newPage();
      await target.goto(baseUrl);
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${id}/sidepanel.html`);
      await panel.evaluate(
        async ({ baseUrl, provider }) => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((tab) => tab.url?.startsWith(baseUrl));
          if (!tab?.id) throw new Error("Missing target tab");
          await chrome.runtime.sendMessage({
            type: "target:switch",
            payload: { tabId: tab.id },
          });
          await chrome.storage.local.set({
            settings: {
              apiKey: "test",
              baseUrl,
              provider,
              model: "test",
              enableScreenshotPruning: true,
              screenshotPruneTrigger: 2,
              screenshotKeepN: 1,
            },
          });
        },
        { baseUrl, provider },
      );
      // When：通过真实 UI 发起截图任务。
      await panel.getByRole("textbox").fill("capture screenshot");
      await panel.getByRole("textbox").press("Enter");
      await expect(panel.getByText("completed", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(() =>
          panel.evaluate(
            async () => (await chrome.storage.local.get("chatLogs")).chatLogs,
          ),
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              toolName: "screenshot",
              screenshot: expect.objectContaining({ mime: "image/png" }),
            }),
          ]),
        );
      const stored = await panel.evaluate(async () => ({
        local: await chrome.storage.local.get("chatLogs"),
        session: await chrome.storage.session.get("conversationState"),
      }));
      // Then：持久化只含引用，模型收到图片，跨上下文 Blob 可预览。
      expect(JSON.stringify(stored)).not.toContain("base64,");
      expect(JSON.stringify(stored)).not.toContain("screenshotData");
      expect(
        stored.local.chatLogs.filter(
          (entry: { prunedFromContext?: boolean }) => entry.prunedFromContext,
        ),
      ).toHaveLength(2);
      expect(requests).toHaveLength(2);
      if (provider === "openai") {
        expect(requests[1]).toContain("data:image/png;base64,");
        expect(requests[1]?.match(/"type":"image_url"/g)).toHaveLength(1);
      } else {
        expect(requests[1]).toContain('"type":"base64"');
        expect(requests[1]?.match(/"type":"image"/g)).toHaveLength(1);
      }
      await panel.bringToFront();
      const steps = panel.getByRole("button", { name: "3 steps", exact: true });
      if ((await steps.getAttribute("aria-expanded")) !== "true")
        await steps.click();
      await panel
        .getByRole("button", { name: /Take screenshot/ })
        .first()
        .click();
      await expect(panel.getByAltText("浏览器截图")).toHaveAttribute(
        "src",
        /^blob:/,
      );
      await expect(panel.getByAltText("浏览器截图")).toBeVisible();
      await expect(panel.getByAltText("浏览器截图")).toHaveCSS(
        "opacity",
        "0.5",
      );
      await expect(panel.getByText("已从上下文删除")).toBeVisible();
      await panel.screenshot({
        path: testInfo.outputPath("indexeddb-preview.png"),
        animations: "disabled",
      });
      await panel.evaluate(() =>
        chrome.runtime.sendMessage({ type: "cdp:detach" }),
      );
      // 设置页不持有内存截图引用，也不自行触发回收。
      await panel.goto(`chrome-extension://${id}/options.html`);
      const retainedKeys = await assetKeys(panel);
      const orphan = await seedOrphan(panel);
      const workerControl = await context.newCDPSession(panel);
      const versionReady = new Promise<string>((resolve) => {
        workerControl.on(
          "ServiceWorker.workerVersionUpdated",
          ({ versions }) => {
            const version = versions.find((version) =>
              version.scriptURL.startsWith(`chrome-extension://${id}/`),
            );
            if (version) resolve(version.versionId);
          },
        );
      });
      await workerControl.send("ServiceWorker.enable");
      await test.step(
        "停止本扩展后台",
        async () => {
          await workerControl.send("ServiceWorker.stopWorker", {
            versionId: await versionReady,
          });
        },
        { timeout: 10_000 },
      );
      await workerControl.detach();
      await panel.evaluate(() => chrome.runtime.sendMessage({ type: "cdp:status" }));
      await expect.poll(() => assetKeys(panel)).not.toContain(orphan);
      expect(await assetKeys(panel)).toEqual(retainedKeys);
      await panel.goto(`chrome-extension://${id}/sidepanel.html`);
      const restoredSteps = panel.getByRole("button", {
        name: "3 steps",
        exact: true,
      });
      if ((await restoredSteps.getAttribute("aria-expanded")) !== "true")
        await restoredSteps.click();
      await panel
        .getByRole("button", { name: /Take screenshot/ })
        .first()
        .click();
      await expect(panel.getByAltText("浏览器截图")).toBeVisible();
      await expect(panel.getByText("已从上下文删除")).toBeVisible();
      await panel.getByRole("button", { name: "新建对话" }).click();
      await expect.poll(() => assetKeys(panel)).toEqual([]);
      await expect(panel.getByRole("button", { name: /Take screenshot/ })).toHaveCount(0);
    } finally {
      await context.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(profile, { recursive: true, force: true });
    }
  });
}
