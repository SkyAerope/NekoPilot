import { expect, test, type Page } from "@playwright/test";
import { installHarness, screenshotData } from "../helpers/harness";
import { assetKeys } from "../helpers/asset-database";

async function holdMigration(page: Page) {
  await page.addInitScript(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release: (() => void) | undefined;
    Object.defineProperty(window, "releaseScreenshotMigration", {
      value: () => release?.(),
    });
    crypto.subtle.digest = (algorithm, bytes) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        void digest(algorithm, bytes).then((value) => {
          release = () => resolve(value);
          document.documentElement.dataset.migrationPending = "true";
        }, reject);
      });
  });
}

test("旧截图迁移后只保存引用，摘除标记保留且可预览", async ({ page }) => {
  // Given：旧日志同时在正文和工具结果中存放 Base64。
  await installHarness(page, {
    chatLogs: [
      {
        id: 1,
        type: "tool_call",
        toolName: "screenshot",
        content: "{}",
        timestamp: 1,
        toolSuccess: true,
        prunedFromContext: true,
        screenshotData,
        screenshotMime: "image/png",
        toolResult: JSON.stringify({ data: screenshotData, mime: "image/png" }),
      },
    ],
  });
  // When：恢复旧日志。
  await page.goto("/sidepanel.html");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const entries = window.__harness.storage.chatLogs;
        return JSON.stringify(entries);
      }),
    )
    .not.toContain(screenshotData);
  // Then：只保存引用，截图仍显示，上下文状态不丢失。
  const stored = await page.evaluate(() => window.__harness.storage.chatLogs);
  expect(stored).toMatchObject([
    {
      screenshot: { mime: "image/png", width: 1, height: 1 },
      prunedFromContext: true,
    },
  ]);
  await page.getByRole("button", { name: /截图/ }).click();
  await expect(page.getByAltText("浏览器截图")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await expect(page.getByText("已从上下文删除")).toBeVisible();
});

test("迁移未完成时清空对话，旧异步结果不会恢复日志", async ({ page }) => {
  // Given：哈希计算刻意停在文件提交前。
  await holdMigration(page);
  await installHarness(page, {
    chatLogs: [
      {
        id: 1,
        type: "tool_call",
        toolName: "screenshot",
        content: "{}",
        timestamp: 1,
        screenshotData,
        toolResult: "done",
        toolSuccess: true,
      },
    ],
  });
  await page.goto("/sidepanel.html");
  await expect(page.locator("html")).toHaveAttribute(
    "data-migration-pending",
    "true",
  );
  // When：清空后才允许迁移返回。
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.evaluate(() => {
    const release: unknown = Reflect.get(window, "releaseScreenshotMigration");
    if (typeof release === "function") release();
  });
  // Then：迟到的恢复操作不能复活旧对话。
  await expect
    .poll(() => page.evaluate(() => window.__harness.storage.chatLogs))
    .toEqual([]);
  await expect(
    page.getByRole("button", { name: /截图/ }),
  ).toHaveCount(0);
  await expect.poll(() => assetKeys(page)).toEqual([]);
});

test("新建对话等待已提交的保存，再回收不再被引用的截图", async ({ page }) => {
  // Given：已迁移的截图，随后一次保存停在 storage.set 内。
  await installHarness(page, { chatLogs: [{
    id: 1, type: "tool_call", toolName: "screenshot", content: "{}", timestamp: 1,
    screenshotData, toolResult: "done", toolSuccess: true,
  }] });
  await page.goto("/sidepanel.html");
  await expect.poll(() => page.evaluate(() => JSON.stringify(window.__harness.storage.chatLogs))).not.toContain(screenshotData);
  await page.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    Object.defineProperty(chrome.storage.local, "set", { value: async (values: Record<string, unknown>) => {
      await new Promise<void>((resolve) => {
        Object.defineProperty(window, "releaseChatSave", { value: () => {
          Object.defineProperty(chrome.storage.local, "set", { value: set, configurable: true });
          resolve();
        }, configurable: true });
        document.documentElement.dataset.chatSavePending = "true";
      });
      await set(values);
    }, configurable: true });
    window.__harness.emit({ type: "message", data: "pending save" });
  });
  await expect(page.locator("html")).toHaveAttribute("data-chat-save-pending", "true");
  // When：清空操作与在途存储提交竞争。
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.evaluate(() => {
    const release: unknown = Reflect.get(window, "releaseChatSave");
    if (typeof release === "function") release();
  });
  // Then：旧保存完成后清空才提交，截图不复活且 Blob 被回收。
  await expect(page.getByRole("button", { name: /截图/ })).toHaveCount(0);
  await expect.poll(() => assetKeys(page)).toEqual([]);
  const stored = await page.evaluate(() => window.__harness.storage.chatLogs);
  expect(stored === undefined || (Array.isArray(stored) && stored.length === 0)).toBe(true);
});

test("迁移期间发送新消息，恢复后保留旧截图与新消息", async ({ page }) => {
  // Given：尚未恢复的旧截图。
  await holdMigration(page);
  await installHarness(page, {
    chatLogs: [
      {
        id: 1,
        type: "tool_call",
        toolName: "screenshot",
        content: "{}",
        timestamp: 1,
        screenshotData,
        toolResult: "done",
        toolSuccess: true,
      },
    ],
  });
  await page.goto("/sidepanel.html");
  await expect(page.locator("html")).toHaveAttribute(
    "data-migration-pending",
    "true",
  );
  // When：新消息先到达，随后完成旧数据恢复。
  await page.getByRole("textbox").fill("new turn during migration");
  await page.getByRole("textbox").press("Enter");
  await page.evaluate(() => {
    const release: unknown = Reflect.get(window, "releaseScreenshotMigration");
    if (typeof release === "function") release();
  });
  // Then：既不覆盖新消息，也不丢弃旧截图。
  await expect(
    page.getByRole("button", { name: /截图/ }),
  ).toBeVisible();
  await expect(
    page.getByText("new turn during migration", { exact: true }),
  ).toBeVisible();
});

test("引用的文件缺失时显示终止失败状态，不无限加载", async ({ page }) => {
  // Given：元数据存在，但文件已不在数据库中。
  await installHarness(page, {
    chatLogs: [
      {
        id: 1,
        type: "tool_call",
        toolName: "screenshot",
        content: "{}",
        timestamp: 1,
        screenshot: {
          id: "missing",
          mime: "image/png",
          size: 10,
          width: 1,
          height: 1,
        },
        toolResult: "done",
        toolSuccess: true,
      },
    ],
  });
  await page.goto("/sidepanel.html");
  // When：展开预览。
  await page.getByRole("button", { name: /截图/ }).click();
  // Then：显示明确失败且不泄漏空白图片。
  await expect(page.getByText("截图加载失败", { exact: true })).toBeVisible();
  await expect(page.getByAltText("浏览器截图")).toHaveCount(0);
});

test("清空对话释放已预解码截图的 Blob URL", async ({ page }) => {
  // Given：记录真实 URL 生命周期。
  await page.addInitScript(() => {
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    const live = new Set<string>();
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      live.add(url);
      document.documentElement.dataset.liveUrls = String(live.size);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      live.delete(url);
      document.documentElement.dataset.liveUrls = String(live.size);
      revoke(url);
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
        screenshotData,
        screenshotMime: "image/png",
        toolResult: "done",
        toolSuccess: true,
      },
    ],
  });
  await page.goto("/sidepanel.html");
  await page.getByRole("button", { name: /截图/ }).hover();
  await expect(page.locator("html")).toHaveAttribute("data-live-urls", "1");
  // When：清空对话。
  await page.getByRole("button", { name: "新建对话" }).click();
  // Then：文件预览不再持有文档级资源。
  await expect(page.locator("html")).toHaveAttribute("data-live-urls", "0");
});
