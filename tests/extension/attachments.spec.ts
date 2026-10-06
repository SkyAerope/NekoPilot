import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import sharp from "sharp";
import { assetKeys } from "../helpers/asset-database";

for (const provider of ["openai", "anthropic"] as const) {
  test(`真实扩展附件传递、持久化和编辑重试：${provider}`, async ({}, testInfo) => {
    // Given：真实浏览器、扩展后台及 HTTP 级提供商替身。
    const requests: string[] = [];
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const fileBody = "attachment fixture 独立内容 42";
    const server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Headers", "*");
      if (request.method === "OPTIONS") {
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.end("<title>Attachment target</title><h1>fixture</h1>");
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        requests.push(body);
        response.setHeader("Content-Type", "text/event-stream");
        const events =
          provider === "openai"
            ? [{ choices: [{ delta: { content: "completed" } }] }]
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
      throw new Error("Missing port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const profile = await mkdtemp(join(tmpdir(), "nekopilot-attachments-"));
    const context = await chromium.launchPersistentContext(profile, {
      channel: process.env.EXTENSION_CHANNEL || "msedge",
      headless: true,
      args: ["--enable-unsafe-extension-debugging"],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    try {
      const browser = context.browser();
      if (!browser) throw new Error("Missing browser");
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
          const tab = (await chrome.tabs.query({})).find((tab) =>
            tab.url?.startsWith(baseUrl),
          );
          if (!tab?.id) throw new Error("Missing target");
          await chrome.runtime.sendMessage({
            type: "target:switch",
            payload: { tabId: tab.id },
          });
          await chrome.storage.local.set({
            settings: { apiKey: "test", baseUrl, provider, model: "test" },
          });
        },
        { baseUrl, provider },
      );
      await panel
        .locator('input[type="file"]')
        .last()
        .setInputFiles([
          { name: "pixel.png", mimeType: "image/png", buffer: image },
          {
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from(fileBody),
          },
        ]);
      // When：纯附件通过实际 UI、Chrome 消息、后台传给提供商。
      await panel
        .getByRole("button", { name: "发送消息", exact: true })
        .click();
      await expect(panel.getByText("completed", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        panel.getByRole("button", { name: "添加附件" }),
      ).toBeEnabled();
      // Then：验证输入字节而非文件名或实现细节。
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(fileBody);
      expect(requests[0]).toContain(image.toString("base64"));
      expect(requests[0]).toContain(
        provider === "openai" ? '"type":"image_url"' : '"type":"image"',
      );
      await expect
        .poll(() =>
          panel.evaluate(
            async () =>
              (await chrome.storage.local.get("chatLogs")).chatLogs?.filter(
                (entry: { attachments?: unknown[] }) =>
                  entry.attachments?.length,
              ).length,
          ),
        )
        .toBe(1);
      const stored = await panel.evaluate(async () => ({
        local: await chrome.storage.local.get("chatLogs"),
        session: await chrome.storage.session.get("conversationState"),
      }));
      expect(JSON.stringify(stored)).not.toContain(image.toString("base64"));
      expect(JSON.stringify(stored)).not.toContain(fileBody);
      expect(await assetKeys(panel)).toHaveLength(2);
      await panel.screenshot({
        path: testInfo.outputPath("accepted-attachments.png"),
      });

      await test.step("后续请求保留附件上下文", async () => {
        await panel
          .getByRole("textbox", { name: "任务内容", exact: true })
          .fill("follow up");
        await panel
          .getByRole("textbox", { name: "任务内容", exact: true })
          .press("Enter");
        await expect.poll(() => requests.length).toBe(2);
        await expect(panel.getByText("completed", { exact: true })).toHaveCount(
          2,
        );
        await expect(
          panel.getByRole("button", { name: "添加附件" }),
        ).toBeEnabled();
        expect(requests[1]).toContain(fileBody);
        expect(requests[1]).toContain(image.toString("base64"));
      });
      await test.step("重开面板后编辑附件消息仍发送相同内容", async () => {
        await panel.evaluate(() =>
          chrome.runtime.sendMessage({ type: "cdp:detach" }),
        );
        await panel.goto(`chrome-extension://${id}/options.html`);
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
        await workerControl.send("ServiceWorker.stopWorker", {
          versionId: await versionReady,
        });
        await workerControl.detach();
        await panel.evaluate(() =>
          chrome.runtime.sendMessage({ type: "cdp:status" }),
        );
        await panel.goto(`chrome-extension://${id}/sidepanel.html`);
        await panel
          .getByRole("button", { name: "编辑", exact: true })
          .first()
          .click();
        await panel
          .getByRole("textbox", { name: "编辑消息内容" })
          .fill("edited instruction");
        await panel.getByRole("button", { name: "保存并重新发送" }).click();
        await expect.poll(() => requests.length).toBe(3);
        await expect(panel.getByText("completed", { exact: true })).toHaveCount(
          1,
        );
        await expect(
          panel.getByRole("button", { name: "添加附件" }),
        ).toBeEnabled();
        expect(requests[2]).toContain("edited instruction");
        expect(requests[2]).toContain(fileBody);
        expect(requests[2]).toContain(image.toString("base64"));
      });
      await panel.getByRole("button", { name: "新建对话" }).click();
      await expect.poll(() => assetKeys(panel)).toEqual([]);
    } finally {
      await context.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(profile, { recursive: true, force: true });
    }
  });
}
