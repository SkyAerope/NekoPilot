import { expect, test } from "@playwright/test";
import { loadAttachments } from "../helpers/attachment-modules";

test.beforeEach(async ({ page }) => loadAttachments(page));

test("合法引用解析只保留传输字段", async ({ page }) => {
  // Given：附带正文和临时预览字段的外部引用。
  const result = await page.evaluate(() => {
    const asset = {
      id: `text/plain:${"a".repeat(64)}`,
      mime: "text/plain",
      size: 3,
      body: "secret",
    };
    // When：解析附件边界。
    return window.attachmentContract.parseAttachments([
      { kind: "text", name: "a.txt", asset, preview: "data:secret" },
    ]);
  });
  // Then：只有引用、名称与判别字段。
  expect(result).toEqual([
    {
      kind: "text",
      name: "a.txt",
      asset: {
        id: `text/plain:${"a".repeat(64)}`,
        mime: "text/plain",
        size: 3,
      },
    },
  ]);
});

for (const invalid of [
  null,
  {},
  [
    {
      kind: "text",
      name: "a.pdf",
      asset: { id: "x", mime: "application/pdf", size: 1 },
    },
  ],
  [
    {
      kind: "image",
      name: "a.png",
      asset: {
        id: `text/plain:${"a".repeat(64)}`,
        mime: "text/plain",
        size: 1,
      },
    },
  ],
  [
    {
      kind: "text",
      name: "a.txt",
      asset: {
        id: `text/plain:${"a".repeat(64)}`,
        mime: "text/plain",
        size: -1,
      },
    },
  ],
]) {
  test(`不可信附件结构被拒绝：${JSON.stringify(invalid)}`, async ({ page }) => {
    // Given：不合法的序列化数据。
    const code = await page.evaluate((invalid) => {
      // When：解析外部边界。
      try {
        window.attachmentContract.parseAttachments(invalid);
        return "accepted";
      } catch (error) {
        return error instanceof window.attachmentContract.AttachmentError
          ? error.code
          : "unexpected";
      }
    }, invalid);
    // Then：结构错误具有稳定错误码。
    expect(code).toBe("invalid_reference");
  });
}

test("发送 Agent 启动消息只携带附件引用", async ({ page }) => {
  // Given：从真实文件准备出的引用。
  const result = await page.evaluate(async () => {
    const prepared = await window.attachmentFiles.prepareAttachments([
      new File(["hello"], "a.txt"),
    ]);
    try {
      // When：使用带类型的启动入口。
      await window.attachmentMessaging.sendAgentStart({
        userMessage: "read",
        config: {
          model: "test",
          apiKey: "test",
          baseUrl: "https://example.invalid",
          provider: "openai",
          permissionMode: "ask",
          showClickMarker: true,
          enableShortRefs: true,
          screenshotScaleMode: "off",
          screenshotMaxLongEdge: 1568,
          screenshotMaxPixels: 1150000,
          enableScreenshotPruning: false,
          screenshotKeepN: 3,
          screenshotPruneTrigger: 12,
          enableCodeExecution: false,
          codeExecutionTimeoutMs: 1000,
          codeExecutionMaxOutputChars: 6000,
          enablePromptCaching: false,
        },
        attachments: prepared.attachments,
        messageId: 1,
        retryTurnIndex: 2,
      });
      return window.attachmentSent;
    } finally {
      await prepared.release();
    }
  });
  // Then：Chrome 消息使用普通引用，没有 File/Blob/Base64 正文。
  expect(result).toEqual([
    {
      type: "agent:start",
      payload: {
        userMessage: "read",
        config: expect.objectContaining({ model: "test" }),
        attachments: [
          {
            kind: "text",
            name: "a.txt",
            asset: {
              id: expect.stringMatching(/^text\/plain:[a-f0-9]{64}$/),
              mime: "text/plain",
              size: 5,
            },
          },
        ],
        messageId: 1,
        retryTurnIndex: 2,
      },
    },
  ]);
});
