import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import type { TargetTab, TargetTabStatus } from "../../src/shared/target-tab";

type AgentEvent = { type: string; data: unknown };
type Harness = {
  storage: Record<string, unknown>;
  messages: { type: string; payload?: Record<string, unknown> }[];
  emit: (event: AgentEvent) => void;
  bindTarget: (
    messageId: number,
    target: TargetTab,
    showChip?: boolean,
  ) => void;
  lastPromptTabId?: number;
  targetStatus: TargetTabStatus;
  switchError?: string;
  statusError?: string;
  reloadCount: number;
  followingActive: boolean;
  tabs: TargetTab[] | null;
};

declare global {
  interface Window {
    __harness: Harness;
  }
}

const screenshotData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

async function installHarness(
  page: Page,
  initial: Record<string, unknown> = {},
) {
  await page.addInitScript((initialStorage) => {
    const storage: Record<string, unknown> = {
      settings: {
        apiKey: "test-key",
        model: "custom-model",
        baseUrl: "https://example.invalid/v1",
      },
      ...initialStorage,
    };
    const messageListeners = new Set<(message: unknown) => void>();
    const storageListeners = new Set<(changes: unknown) => void>();
    const messages: Harness["messages"] = [];
    const changed = {
      addListener: (listener: (changes: unknown) => void) =>
        storageListeners.add(listener),
      removeListener: (listener: (changes: unknown) => void) =>
        storageListeners.delete(listener),
    };
    const harness: Harness = {
      storage,
      messages,
      statusError: initialStorage.statusError as string | undefined,
      reloadCount: 0,
      followingActive: initialStorage.followingActive === true,
      tabs: (initialStorage.tabs as TargetTab[]) || null,
      targetStatus: (initialStorage.targetStatus as TargetTabStatus) || {
        target: { id: 1, title: "示例页面", url: "https://example.invalid" },
        active: { id: 1, title: "示例页面", url: "https://example.invalid" },
        missing: false,
        busy: false,
      },
      emit: (event) =>
        messageListeners.forEach((listener) =>
          listener({ type: "agent:event", payload: event }),
        ),
      bindTarget: (messageId, target, showChip = true) =>
        messageListeners.forEach((listener) =>
          listener({
            type: "target:bound",
            payload: { messageId, target, showChip },
          }),
        ),
    };
    const chromeMock = {
      runtime: {
        lastError: undefined,
        onMessage: {
          addListener: (listener: (message: unknown) => void) =>
            messageListeners.add(listener),
          removeListener: (listener: (message: unknown) => void) =>
            messageListeners.delete(listener),
        },
        openOptionsPage: () => {},
        reload: () => {
          harness.reloadCount++;
        },
        sendMessage: (
          message: Harness["messages"][number],
          callback: (result: unknown) => void,
        ) => {
          messages.push(message);
          if (
            message.type === "agent:start" &&
            typeof message.payload?.messageId === "number" &&
            harness.targetStatus.target
          ) {
            harness.bindTarget(
              message.payload.messageId,
              harness.targetStatus.target,
              harness.lastPromptTabId !== harness.targetStatus.target.id,
            );
            harness.lastPromptTabId = harness.targetStatus.target.id;
          }
          if (message.type === "target:status" && harness.followingActive) {
            harness.targetStatus.target = harness.targetStatus.active;
            if (message.payload?.hasMessages) harness.followingActive = false;
          }
          if (message.type === "agent:reset") {
            harness.lastPromptTabId = undefined;
            harness.followingActive = true;
            harness.targetStatus.target = harness.targetStatus.active;
          }
          if (message.type === "target:status" && harness.statusError) {
            queueMicrotask(() => callback({ error: harness.statusError }));
            return;
          }
          if (message.type === "target:switch") {
            if (harness.switchError) {
              queueMicrotask(() => callback({ error: harness.switchError }));
              return;
            }
            const selected =
              harness.tabs?.find((tab) => tab.id === message.payload?.tabId) ||
              harness.targetStatus.active;
            harness.targetStatus.target = selected;
            harness.targetStatus.active = selected;
          }
          const result =
            message.type === "target:list"
              ? {
                  tabs:
                    harness.tabs ||
                    Array.from(
                      new Map(
                        [
                          harness.targetStatus.target,
                          harness.targetStatus.active,
                        ]
                          .filter((tab): tab is TargetTab => tab !== null)
                          .map((tab) => [tab.id, tab]),
                      ).values(),
                    ),
                }
              : message.type === "target:status" ||
                  message.type === "target:switch"
                ? harness.targetStatus
                : message.type === "settings:get"
                  ? storage.settings
                  : message.type === "cdp:status"
                    ? { attached: false }
                    : message.type === "pick:start"
                      ? {
                          element: {
                            tag: "button",
                            selector: "#submit",
                            text: "提交",
                            rect: { x: 10, y: 20, w: 80, h: 30 },
                          },
                        }
                      : {};
          if (message.type === "target:list" && initialStorage.tabListDelay) {
            window.setTimeout(
              () => callback(structuredClone(result)),
              Number(initialStorage.tabListDelay),
            );
          } else {
            queueMicrotask(() => callback(structuredClone(result)));
          }
        },
      },
      storage: {
        onChanged: changed,
        local: {
          onChanged: changed,
          get: (
            keys: string | string[],
            callback: (result: Record<string, unknown>) => void,
          ) => {
            const result: Record<string, unknown> = {};
            for (const key of typeof keys === "string" ? [keys] : keys)
              result[key] = storage[key];
            queueMicrotask(() => callback(result));
          },
          set: (values: Record<string, unknown>) => {
            const changes: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(values)) {
              changes[key] = { oldValue: storage[key], newValue: value };
              storage[key] = value;
            }
            queueMicrotask(() =>
              storageListeners.forEach((listener) => listener(changes)),
            );
          },
          remove: (keys: string | string[]) => {
            for (const key of typeof keys === "string" ? [keys] : keys)
              delete storage[key];
          },
        },
      },
    };
    Object.defineProperty(window, "chrome", {
      value: chromeMock,
      configurable: true,
    });
    window.__harness = harness;
  }, initial);
  // 使用生产资源并应用扩展同等脚本策略，检查组件是否依赖远程脚本或 eval。
  await page.route("**/*.html", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "content-security-policy":
          "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
      },
    });
  });
}

async function emit(page: Page, type: string, data: unknown) {
  await page.evaluate((event) => window.__harness.emit(event), { type, data });
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("输入区显示图标操作与标签页纸片，窄侧栏不溢出", async ({ page }) => {
  await installHarness(page, {
    autoMode: true,
    targetStatus: {
      target: {
        id: 1,
        title: "这是一个很长的操作标签页标题，用来检查单行截断和窄侧栏布局",
        url: "https://example.invalid",
        favIconUrl: screenshotData.replace(/^/, "data:image/png;base64,"),
      },
      active: {
        id: 1,
        title: "这是一个很长的操作标签页标题，用来检查单行截断和窄侧栏布局",
        url: "https://example.invalid",
      },
      missing: false,
      busy: false,
    },
  });
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto("/sidepanel.html");
  await expect(page.locator("header")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /CDP/ })).toHaveCount(0);
  const mode = page.getByRole("button", { name: "自动模式", exact: true });
  await expect(mode).toHaveText("");
  await mode.hover();
  await expect(page.getByRole("tooltip")).toHaveText("切换审核模式");
  await mode.click();
  await expect(
    page.getByRole("menuitemradio", { name: "执行前询问" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("menuitemradio", { name: "自动执行" })
      .locator(".lucide-check"),
  ).toHaveCount(1);
  await expect(page.locator(".lucide-circle")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  await expect(
    page.getByText(/Auto mode|Ask before acting|Auto 模式/),
  ).toHaveCount(0);
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  await expect(chip.locator("img")).toBeVisible();
  expect(
    await chip
      .locator("span.truncate")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  const create = await page
    .getByRole("button", { name: "新建对话" })
    .boundingBox();
  const modeBox = await mode.boundingBox();
  const picker = await page
    .getByRole("button", { name: "选择页面元素" })
    .boundingBox();
  const settings = await page
    .getByRole("button", { name: "设置", exact: true })
    .boundingBox();
  expect(create!.x).toBeLessThan(modeBox!.x);
  expect(modeBox!.x).toBeLessThan(picker!.x);
  expect(settings!.y).toBeGreaterThan(picker!.y);
  await chip.click();
  await expect(page.getByRole("option")).toHaveAttribute(
    "data-target-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expectNoOverflow(page);
  await page.screenshot({ path: "test-results/composer-target-tab.png" });
});

test("旧后台提示重新加载，恢复状态后自动清除提示", async ({ page }) => {
  await installHarness(page, {
    statusError: "Error: Unknown message type: target:status",
  });
  await page.goto("/sidepanel.html");
  await expect(page.getByRole("alert")).toContainText(
    "扩展后台仍是旧版本，请重新加载扩展。",
  );
  await expect(
    page.getByText("Error: Error: Unknown message type: target:status"),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "任务内容" }).fill("执行任务");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "重新加载扩展", exact: true }).click();
  expect(await page.evaluate(() => window.__harness.reloadCount)).toBe(1);
  await page.evaluate(() => {
    window.__harness.statusError = undefined;
  });
  await expect(
    page.getByRole("button", { name: "操作标签页", exact: true }),
  ).toHaveText("示例页面");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
});

test("用户气泡下方保存标签页纸片，图标加载时占位，切换与恢复不改旧纸片", async ({
  page,
}) => {
  const tabs: TargetTab[] = [
    {
      id: 1,
      title: "原页面 A",
      url: "https://example.invalid/a",
      favIconUrl: "https://example.invalid/tab-icon.png",
    },
    { id: 2, title: "新页面 B", url: "https://example.invalid/b" },
  ];
  let releaseIcon!: () => void;
  const iconReady = new Promise<void>((resolve) => {
    releaseIcon = resolve;
  });
  const icon = await readFile("dist/icons/icon-16.png");
  await page.route("https://example.invalid/tab-icon.png", async (route) => {
    await iconReady;
    await route.fulfill({ contentType: "image/png", body: icon });
  });
  await installHarness(page, {
    tabs,
    targetStatus: {
      target: tabs[0],
      active: tabs[0],
      missing: false,
      busy: false,
    },
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/sidepanel.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "任务内容" }).fill("检查页面 A");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const papers = page.locator('[data-slot="message-target-tab"]');
  await expect(papers).toHaveText(["原页面 A"]);
  await expect(papers.first().locator(".lucide-link")).toBeVisible();
  const bubble = page.locator(".is-user > div").first();
  await expect(bubble).toHaveText("检查页面 A");
  expect(await bubble.locator('[data-slot="message-target-tab"]').count()).toBe(
    0,
  );
  const bubbleBox = await bubble.boundingBox();
  const paperBox = await papers.first().boundingBox();
  expect(paperBox!.y).toBeGreaterThanOrEqual(bubbleBox!.y + bubbleBox!.height);
  releaseIcon();
  await expect(papers.first().locator(".lucide-link")).toHaveCount(0);
  await expect(papers.first().locator("img")).toBeVisible();
  await emit(page, "done", "");
  await page.getByRole("button", { name: "操作标签页", exact: true }).click();
  await page.getByRole("option", { name: "新页面 B", exact: true }).click();
  await expect(papers).toHaveText(["原页面 A"]);
  await page.getByRole("textbox", { name: "任务内容" }).fill("检查页面 B");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(papers).toHaveText(["原页面 A", "新页面 B"]);
  await expect(papers.last().locator(".lucide-link")).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({ path: "test-results/user-tab-chips.png" });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.__harness.storage.chatLogs as
              { targetTab?: TargetTab }[] | undefined
          )?.filter((entry) => entry.targetTab).length,
      ),
    )
    .toBe(2);
  const saved = await page.evaluate(() => window.__harness.storage.chatLogs);
  const reopened = await page.context().newPage();
  await installHarness(reopened, { chatLogs: saved });
  await reopened.goto("/sidepanel.html");
  await expect(reopened.locator('[data-slot="message-target-tab"]')).toHaveText(
    ["原页面 A", "新页面 B"],
  );
  await reopened.close();
});

test("后台绑定修正气泡页面快照，失败图标显示链接占位", async ({ page }) => {
  await page.route("https://example.invalid/missing-icon.png", (route) =>
    route.fulfill({ status: 404 }),
  );
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await page.getByRole("textbox", { name: "任务内容" }).fill("检查实际页面");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.evaluate(() => {
    const messageId = window.__harness.messages.find(
      (message) => message.type === "agent:start",
    )!.payload!.messageId as number;
    window.__harness.bindTarget(messageId, {
      id: 3,
      title: "实际连接页面",
      url: "https://example.invalid/actual",
      favIconUrl: "https://example.invalid/missing-icon.png",
    });
  });
  const paper = page.locator('[data-slot="message-target-tab"]');
  await expect(paper).toHaveText("实际连接页面");
  await expect(paper.locator("img")).toHaveCount(0);
  await expect(paper.locator(".lucide-link")).toBeVisible();
});

test("连续消息只在首条和切页后的首条显示纸片，旧历史也按此规则恢复", async ({
  page,
}) => {
  const tabs: TargetTab[] = [
    { id: 1, title: "页面 A", url: "https://example.invalid/a" },
    { id: 2, title: "页面 B", url: "https://example.invalid/b" },
  ];
  await installHarness(page, {
    tabs,
    targetStatus: {
      target: tabs[0],
      active: tabs[0],
      missing: false,
      busy: false,
    },
  });
  await page.goto("/sidepanel.html");
  const send = async (text: string) => {
    await page.getByRole("textbox", { name: "任务内容" }).fill(text);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await emit(page, "done", "");
  };
  const papers = page.locator('[data-slot="message-target-tab"]');
  await send("第一条");
  await expect(papers).toHaveText(["页面 A"]);
  await send("第二条");
  await expect(papers).toHaveText(["页面 A"]);
  await page.getByRole("button", { name: "操作标签页", exact: true }).click();
  await page.getByRole("option", { name: "页面 B", exact: true }).click();
  await send("切换后第一条");
  await expect(papers).toHaveText(["页面 A", "页面 B"]);
  await send("切换后第二条");
  await expect(papers).toHaveText(["页面 A", "页面 B"]);
  const reopened = await page.context().newPage();
  await installHarness(reopened, {
    chatLogs: [0, 1, 2, 3].map((index) => ({
      id: index + 1,
      type: "user",
      content: `历史消息 ${index}`,
      timestamp: index,
      targetTab: tabs[index < 2 ? 0 : 1],
    })),
  });
  await reopened.goto("/sidepanel.html");
  await expect(reopened.locator('[data-slot="message-target-tab"]')).toHaveText(
    ["页面 A", "页面 B"],
  );
  await reopened.close();
});

test("标签页菜单置顶目标、显示四个最近页，并按标题链接搜索全部标签页", async ({
  page,
}) => {
  const tabs: TargetTab[] = Array.from({ length: 7 }, (_, index) => ({
    id: index + 1,
    title: index === 0 ? "当前操作页" : `页面 ${index + 1}`,
    url: `https://example.invalid/tab-${index + 1}/${"long-path/".repeat(8)}`,
    lastAccessed: index * 100,
  }));
  await installHarness(page, {
    tabs,
    targetStatus: {
      target: tabs[0],
      active: tabs[0],
      busy: false,
      missing: false,
    },
  });
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto("/sidepanel.html");
  expect(
    await page.evaluate(
      () =>
        window.__harness.messages.filter(
          (message) => message.type === "target:list",
        ).length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "操作标签页", exact: true }).click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(5);
  expect(
    await options.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")),
    ),
  ).toEqual(["当前操作页", "页面 7", "页面 6", "页面 5", "页面 4"]);
  await expect(
    options.first().locator('[data-slot="target-check"]'),
  ).toBeVisible();
  await expect(
    options.nth(1).locator('[data-slot="target-check"]'),
  ).toHaveCount(0);
  expect(
    await options
      .first()
      .locator("p")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await expect(page.getByText("切换标签页", { exact: true })).toHaveCount(0);
  await expectNoOverflow(page);
  await page.screenshot({ path: "test-results/tab-selector-recent.png" });
  const search = page.getByRole("combobox", { name: "搜索标签页" });
  await expect(search).toBeFocused();
  await search.fill("页面 2");
  await expect(options).toHaveCount(1);
  await expect(options).toHaveAttribute("aria-label", "页面 2");
  await search.fill("TAB-3");
  await expect(options).toHaveCount(1);
  await expect(options).toHaveAttribute("aria-label", "页面 3");
  await search.fill("不存在的页面");
  await expect(page.getByText("没有匹配的标签页")).toBeVisible();
  await search.fill("tab-2/");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(
    page.getByRole("button", { name: "操作标签页", exact: true }),
  ).toHaveText("页面 2");
  expect(
    await page.evaluate(
      () =>
        window.__harness.messages.filter(
          (message) => message.type === "target:list",
        ).length,
    ),
  ).toBe(1);
});

test("标签页菜单刷新时不闪现加载提示或改变高度，搜索长列表仍可滚动", async ({
  page,
}) => {
  const tabs: TargetTab[] = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    title: `页面 ${index + 1}`,
    url: `https://example.invalid/tab-${index + 1}`,
    lastAccessed: index * 100,
  }));
  await installHarness(page, {
    tabs,
    tabListDelay: 300,
    targetStatus: {
      target: tabs[0],
      active: tabs[0],
      busy: false,
      missing: false,
    },
  });
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto("/sidepanel.html");
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  const list = page.locator('[data-slot="command-list"]');
  const menu = page.getByRole("dialog", { name: "选择操作标签页" });
  const overflow = () =>
    list.evaluate((element) => ({
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
      overflowing: element.scrollHeight > element.clientHeight,
    }));
  await chip.click();
  await expect(list).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("正在获取标签页…")).toHaveCount(0);
  expect((await overflow()).overflowing).toBe(false);
  await expect(page.getByRole("option")).toHaveCount(5);
  await expect(list).toHaveAttribute("aria-busy", "false");
  expect((await overflow()).overflowing).toBe(false);
  const height = await menu.evaluate((element) => element.clientHeight);
  await page.keyboard.press("Escape");
  await chip.click();
  await expect(list).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("正在获取标签页…")).toHaveCount(0);
  expect(await menu.evaluate((element) => element.clientHeight)).toBe(height);
  expect(await overflow()).toMatchObject({ overflowing: false });
  await expect(list).toHaveAttribute("aria-busy", "false");
  expect(await menu.evaluate((element) => element.clientHeight)).toBe(height);
  expect((await overflow()).overflowing).toBe(false);
  await page.getByRole("combobox", { name: "搜索标签页" }).fill("tab-");
  await expect(page.getByRole("option")).toHaveCount(12);
  expect((await overflow()).overflowing).toBe(true);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  await expectNoOverflow(page);
});

test("空对话切页更新纸片并清理元素引用，首条消息后保持目标", async ({
  page,
}) => {
  await installHarness(page, { followingActive: true });
  await page.goto("/sidepanel.html");
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  await expect(chip).toHaveText("示例页面");
  await page.getByRole("button", { name: "选择页面元素" }).click();
  await expect(
    page.getByRole("button", { name: /移除 <button> 提交/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__harness.targetStatus.active = {
      id: 2,
      title: "页面 B",
      url: "https://example.invalid/b",
    };
  });
  await expect(chip).toHaveText("页面 B");
  await expect(
    page.getByRole("button", { name: /移除 <button> 提交/ }),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "任务内容" }).fill("开始任务");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__harness.followingActive))
    .toBe(false);
  await page.evaluate(() => {
    window.__harness.targetStatus.active = {
      id: 1,
      title: "页面 A",
      url: "https://example.invalid/a",
    };
  });
  await chip.click();
  await expect(
    page.getByRole("option", { name: "页面 A", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chip).toHaveText("页面 B");
  await expect(
    page.getByRole("button", { name: "选择页面元素" }),
  ).toBeDisabled();
});

test("标签页不一致时禁用元素选择，切换后更新纸片与选中态", async ({ page }) => {
  const title = "这是一个超过二十个字符的操作标签页标题需要截断显示";
  await installHarness(page, {
    targetStatus: {
      target: { id: 1, title, url: "https://example.invalid/a" },
      active: { id: 2, title: "当前页面 B", url: "https://example.invalid/b" },
      missing: false,
      busy: false,
    },
  });
  await page.goto("/sidepanel.html");
  const picker = page.getByRole("button", { name: "选择页面元素" });
  await expect(picker).toBeDisabled();
  await picker.locator("..").hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    `选择页面元素\n请先切换到“${Array.from(title).slice(0, 20).join("")}...”`,
  );
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  await expect(chip.locator("img")).toHaveCount(0);
  await chip.click();
  await expect(
    page.getByRole("combobox", { name: "搜索标签页" }),
  ).toBeVisible();
  const current = page.getByRole("option", { name: "当前页面 B", exact: true });
  await expect(current).toHaveAttribute("data-target-selected", "false");
  await current.click();
  await expect(chip).toHaveText("当前页面 B");
  await expect(picker).toBeEnabled();
  await chip.click();
  await expect(
    page.getByRole("option", { name: "当前页面 B", exact: true }),
  ).toHaveAttribute("data-target-selected", "true");
  expect(
    await page.evaluate(() =>
      window.__harness.messages.filter(
        (message) => message.type === "target:switch",
      ),
    ),
  ).toEqual([{ type: "target:switch", payload: { tabId: 2 } }]);
});

test("切换失败保留操作页，运行期间禁止切换和元素选择", async ({ page }) => {
  await installHarness(page, {
    targetStatus: {
      target: { id: 1, title: "操作页面 A", url: "https://example.invalid/a" },
      active: { id: 2, title: "当前页面 B", url: "https://example.invalid/b" },
      missing: false,
      busy: false,
    },
  });
  await page.goto("/sidepanel.html");
  await page.evaluate(() => {
    window.__harness.switchError = "连接标签页失败";
  });
  const chip = page.getByRole("button", { name: "操作标签页", exact: true });
  await chip.click();
  await page.getByRole("option", { name: "当前页面 B", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(/连接标签页失败/);
  await expect(chip).toHaveText("操作页面 A");
  await page.getByRole("textbox", { name: "任务内容" }).fill("执行任务");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await chip.click();
  await expect(page.getByText("请先停止任务，再切换标签页")).toBeVisible();
  await expect(
    page.getByRole("option", { name: "当前页面 B", exact: true }),
  ).toHaveAttribute("data-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "选择页面元素" }),
  ).toBeDisabled();
});

test("长对话仅在聊天区滚动，整页不会出现底部空白", async ({ page }) => {
  await installHarness(page, {
    chatLogs: Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      type: index % 2 ? "assistant" : "user",
      content: `消息 ${index + 1}\n${"检查侧边栏滚动布局。\n".repeat(6)}`,
      timestamp: index + 1,
    })),
  });
  await page.goto("/sidepanel.html");
  await expect(page.getByText("消息 30", { exact: false })).toBeVisible();

  const chat = page.locator("#root > div > div");
  const expectPageWithinViewport = async () => {
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight,
        ),
      )
      .toBe(true);
  };

  await expectPageWithinViewport();
  expect(
    await chat.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);

  await chat.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByText(/^消息 1\n/)).toBeInViewport();
  await expectPageWithinViewport();

  await page.setViewportSize({ width: 320, height: 600 });
  await chat.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText("消息 30", { exact: false })).toBeInViewport();
  await expectPageWithinViewport();

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await expect(
    page.getByRole("textbox", { name: "任务内容" }),
  ).toBeInViewport();
});

for (const mode of ["正文", "思考", "思考框"] as const) {
  test(`${mode}流式输出时一次向上滚轮即可暂停跟随，回到底部后恢复`, async ({
    page,
  }) => {
    await installHarness(page, {
      chatLogs: Array.from({ length: 12 }, (_, index) => ({
        id: index + 1,
        type: index % 2 ? "assistant" : "user",
        content: `历史消息 ${index + 1}\n${"历史内容。\n\n".repeat(4)}`,
        timestamp: index + 1,
      })),
    });
    await page.goto("/sidepanel.html");
    await page.getByRole("textbox", { name: "任务内容" }).fill("继续输出");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await emit(page, "message", "");
    const content = "流式内容。\n\n".repeat(30);
    await emit(
      page,
      "message_delta",
      mode === "正文" ? content : `<think>${content}`,
    );

    const chat = page.locator("#root > div > div");
    const scroller =
      mode === "思考框" ? chat.locator(".overflow-y-auto") : chat;
    const distanceToBottom = () =>
      scroller.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      );
    await expect.poll(distanceToBottom).toBeLessThanOrEqual(1);
    expect(
      await scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    ).toBeGreaterThan(100);
    await scroller.hover();
    await page.mouse.wheel(0, -24);
    await expect.poll(distanceToBottom).toBeGreaterThan(10);
    const pausedTop = await scroller.evaluate((element) => element.scrollTop);
    for (let index = 0; index < 5; index++) {
      await emit(page, "message_delta", `新增段落 ${index}。\n\n`);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(
        await scroller.evaluate((element) => element.scrollTop),
      ).toBeCloseTo(pausedTop, 0);
    }

    await page.mouse.wheel(0, 10000);
    await expect.poll(distanceToBottom).toBeLessThanOrEqual(1);
    await emit(page, "message_delta", "恢复跟随。\n\n".repeat(4));
    await expect.poll(distanceToBottom).toBeLessThanOrEqual(1);
    if (mode === "思考框") {
      await emit(
        page,
        "message_delta",
        `</think>${"后续正文。\n\n".repeat(30)}`,
      );
      await expect
        .poll(() =>
          chat.evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
  });
}

test("思考框上划后，延迟到达的底部滚动事件不会重新开启吸附", async ({
  page,
}) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "thinking", "思考内容。\n\n".repeat(30));
  const scroller = page.locator(".max-h-50.overflow-y-auto");
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  await scroller.evaluate((element) => {
    // 模拟旧滚动操作的事件晚于新滚轮输入到达。
    element.scrollTop -= 1;
    element.dispatchEvent(new Event("scroll"));
    element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -24, bubbles: true }),
    );
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  const pausedTop = await scroller.evaluate((element) => element.scrollTop);
  await emit(page, "thinking_delta", "新的思考段落。\n\n".repeat(5));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(
    pausedTop,
    0,
  );
});

test("设置保留自由模型名、自动保存和条件字段", async ({ page }) => {
  await installHarness(page);
  await page.goto("/options.html");
  await page.getByLabel("模型", { exact: true }).fill("private-custom-model");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__harness.storage.settings as { model: string }).model,
      ),
    )
    .toBe("private-custom-model");
  await page.getByLabel("提供商", { exact: true }).click();
  await page.getByRole("option", { name: "Anthropic", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "启用提示缓存 (Prompt Caching)" }),
  ).toBeVisible();
  await page
    .getByRole("switch", { name: "启用 execute_js 沙箱代码执行" })
    .click();
  await expect(page.getByText("execute_js 超时", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("截图缩放", { exact: true }).click();
  await page.getByRole("option", { name: "自定义", exact: true }).click();
  await expect(page.getByLabel("最长边像素", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await expectNoOverflow(page);
});

test("模型自动补全支持过滤、输入框键盘选择、自由输入和焦点管理", async ({
  page,
}) => {
  await installHarness(page);
  await page.route("https://example.invalid/v1/models", (route) =>
    route.fulfill({
      json: { data: [{ id: "beta-model" }, { id: "alpha-model" }] },
    }),
  );
  await page.goto("/options.html");
  const input = page.getByRole("combobox", { name: "模型", exact: true });
  await expect(input).toHaveValue("custom-model");
  await page
    .getByRole("button", { name: "从 API 获取模型列表", exact: true })
    .click();
  await input.focus();
  await expect(input).toBeFocused();
  await expect(page.getByRole("option")).toHaveText([
    "alpha-model",
    "beta-model",
  ]);
  await page.getByRole("option", { name: "beta-model", exact: true }).click();
  await expect(input).toHaveValue("beta-model");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-expanded", "false");

  await input.fill("ALPHA");
  await expect(page.getByRole("option")).toHaveText(["alpha-model"]);
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(input).toHaveValue("ALPHA");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("alpha-model");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__harness.storage.settings as { model: string }).model,
      ),
    )
    .toBe("alpha-model");

  await input.fill("private-custom-model");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("可直接使用输入的名称");
  await input.press("Enter");
  await expect(input).toHaveValue("private-custom-model");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__harness.storage.settings as { model: string }).model,
      ),
    )
    .toBe("private-custom-model");
  await input.press("Escape");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await input.press("Tab");
  await expect(input).toHaveAttribute("aria-expanded", "false");

  await page.setViewportSize({ width: 320, height: 800 });
  await input.focus();
  await expect(page.getByRole("option")).toHaveCount(2);
  await expectNoOverflow(page);
});

test("获取模型失败时仍允许输入，并可刷新后选择模型", async ({ page }) => {
  await installHarness(page);
  let failing = true;
  await page.route("https://example.invalid/v1/models", (route) =>
    route.fulfill(
      failing
        ? { status: 503, body: "unavailable" }
        : { json: { data: [{ id: "recovered-model" }] } },
    ),
  );
  await page.goto("/options.html");
  await page
    .getByRole("button", { name: "从 API 获取模型列表", exact: true })
    .click();
  await page.getByLabel("模型", { exact: true }).focus();
  await expect(page.getByRole("alert", { includeHidden: true })).toContainText(
    "HTTP 503",
  );
  await expect(page.getByRole("status")).toContainText("可手动输入");
  await page.keyboard.press("Escape");
  await page.getByLabel("模型", { exact: true }).fill("manual-model");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__harness.storage.settings as { model: string }).model,
      ),
    )
    .toBe("manual-model");
  failing = false;
  await page
    .getByRole("button", { name: "从 API 获取模型列表", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByLabel("模型", { exact: true }).focus();
  await page
    .getByRole("option", { name: "recovered-model", exact: true })
    .click();
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue(
    "recovered-model",
  );
});

test("主题跟随系统并响应存储同步", async ({ page }) => {
  await installHarness(page, { themeMode: "auto" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/options.html");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "切换主题" }).click();
  await page.getByRole("menuitemradio", { name: "明亮模式" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.evaluate(() =>
    (window.chrome.storage.local.set as unknown as (values: object) => void)({
      themeMode: "dark",
    }),
  );
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("输入提交、Shift Enter 换行和停止", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  const input = page.getByRole("textbox", { name: "任务内容" });
  await input.fill("读取页面");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("读取页面\n");
  await input.press("Enter");
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.filter(
            (message) => message.type === "agent:start",
          ).length,
      ),
    )
    .toBe(1);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
});

test("工具审批与参数展示不依赖 AI SDK 后端", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "click-1",
    name: "click",
    args: '{"selector":"#submit"}',
    needsPermission: true,
  });
  await expect(
    page.getByRole("button", { name: "允许", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Click/ }).click();
  await expect(page.locator("code:visible")).toContainText("#submit");
  await page.getByRole("button", { name: "允许", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__harness.messages.some(
          (message) => message.type === "agent:approve",
        ),
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "允许", exact: true }),
  ).toHaveCount(0);
  await emit(page, "tool_result", {
    id: "click-1",
    name: "click",
    result: { success: true, data: "已点击" },
  });
  await expect(page.locator("code:visible")).toContainText("已点击");
  await emit(page, "tool_call", {
    id: "navigate-1",
    name: "navigate",
    args: '{"url":"https://example.invalid/very/long/url/for/layout"}',
    needsPermission: true,
  });
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__harness.messages.some(
          (message) => message.type === "agent:reject",
        ),
      ),
    )
    .toBe(true);
  await expectNoOverflow(page);
});

test("完成标记工具隐藏标签页但保留失败结果", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "wait-1",
    name: "wait",
    args: '{"ms":200}',
    needsPermission: false,
  });
  await page.getByRole("button", { name: /Wait/ }).click();
  await expect(page.locator("code:visible")).toContainText('"ms": 200');
  await expect(page.getByRole("tab")).toHaveCount(0);
  await emit(page, "tool_result", {
    id: "wait-1",
    name: "wait",
    result: { success: true, data: "done" },
  });
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator("code:visible")).toContainText('"ms": 200');
  await emit(page, "tool_call", {
    id: "click-1",
    name: "click",
    args: '{"selector":"#missing"}',
    needsPermission: false,
  });
  await page.getByRole("button", { name: /Click/ }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await emit(page, "tool_result", {
    id: "click-1",
    name: "click",
    result: { success: false, error: "未找到目标元素" },
  });
  await expect(
    page.getByRole("tab", { name: "结果", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("code:visible").last()).toContainText(
    "未找到目标元素",
  );
  await expectNoOverflow(page);
});

test("恢复历史、截图裁剪标记与重试回滚", async ({ page }) => {
  await installHarness(page, {
    chatLogs: [
      { id: 1, type: "user", content: "检查页面", timestamp: 1 },
      {
        id: 2,
        type: "tool_call",
        content: "{}",
        toolName: "screenshot",
        toolCallId: "shot-1",
        toolResult: "done",
        toolSuccess: true,
        screenshotData,
        screenshotMime: "image/png",
        timestamp: 2,
      },
      { id: 3, type: "assistant", content: "页面已检查", timestamp: 3 },
    ],
  });
  await page.goto("/sidepanel.html");
  await expect(page.getByText("页面已检查", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Take screenshot/ }).click();
  await expect(page.getByAltText("浏览器截图")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await emit(page, "screenshots_pruned", { ids: ["shot-1"] });
  await expect(page.getByText("已从上下文删除", { exact: true })).toBeVisible();
  await expect(page.getByAltText("浏览器截图")).toHaveClass(/grayscale/);
  await page.getByRole("button", { name: "重试", exact: true }).last().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.find(
            (message) => message.type === "agent:truncateBeforeUserTurn",
          )?.payload?.turnIndex,
      ),
    )
    .toBe(0);
});

test("Markdown 表格、公式、代码与无效公式兼容", async ({ page }) => {
  await installHarness(page, {
    chatLogs: [
      {
        id: 1,
        type: "assistant",
        content:
          '| 字段 | 值 |\n| --- | --- |\n| 状态 | 正常 |\n\n公式：$x^2 + y^2$\n\n\\[\\frac{1}{2}\\]\n\n```js\nconst price = "$20";\n```\n\n无效公式：$\\notARealCommand{a}$',
        timestamp: 1,
      },
    ],
  });
  await page.goto("/sidepanel.html");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.locator(".katex")).toHaveCount(2);
  await expect(page.locator("code")).toContainText('const price = "$20";');
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await expectNoOverflow(page);
});

test("流式思考、步骤分组和手动折叠", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "thinking", "正在分析页面");
  await expect(page.getByText("正在分析页面", { exact: true })).toBeVisible();
  await emit(page, "tool_call", {
    id: "read-1",
    name: "read_page",
    args: "{}",
    needsPermission: false,
  });
  await expect(
    page.getByRole("button", { name: "2 steps", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "2 steps", exact: true }).click();
  await emit(page, "tool_result", {
    id: "read-1",
    name: "read_page",
    result: { success: true, data: "页面结构" },
  });
  await expect(
    page.getByRole("button", { name: /Read page structure/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "2 steps", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Read page structure/ }),
  ).toBeVisible();
});

test("空白正文合并前后步骤，后续流式正文仍能显示", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "read-blank",
    name: "read_page",
    args: "{}",
  });
  for (const content of ["", " \n\t", "\u00a0\u3000"]) {
    await emit(page, "message", content);
  }
  await emit(page, "tool_call", {
    id: "wait-blank",
    name: "wait",
    args: '{"ms":1}',
  });
  const group = page.getByRole("button", { name: "2 steps", exact: true });
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".is-assistant")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: /Read page structure/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Wait/ })).toBeVisible();

  await emit(page, "message_delta", "页面分析完成");
  await expect(page.getByText("页面分析完成", { exact: true })).toBeVisible();
  await expect(group).toHaveCount(0);
});

test("截图详情只展示结果，等待和失败时也没有标签页", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "shot-only",
    name: "screenshot",
    args: "{}",
  });
  await page.getByRole("button", { name: /Take screenshot/ }).click();
  await expect(page.getByText("正在截屏…", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await emit(page, "tool_result", {
    id: "shot-only",
    name: "screenshot",
    result: { success: true, data: screenshotData },
  });
  await expect(page.getByAltText("浏览器截图")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await emit(page, "tool_result", {
    id: "shot-only",
    name: "screenshot",
    result: { success: false, error: "截图失败" },
  });
  await expect(page.locator("code:visible")).toContainText("截图失败");
  await expect(page.getByRole("tab")).toHaveCount(0);
});

test("思考转圈和完成勾选保持在同一位置", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await emit(page, "thinking", "检查页面");
  const thinking = page.getByRole("button", { name: /Thinking/ });
  const spinner = await thinking.locator("svg.animate-spin").boundingBox();
  expect(spinner).not.toBeNull();
  await emit(page, "assistant_turn_done", {});
  const completed = page.getByRole("button", { name: /已思考/ });
  await expect(completed.locator("svg.animate-spin")).toHaveCount(0);
  const check = await completed.locator("svg").first().boundingBox();
  expect(check).not.toBeNull();
  expect(
    Math.abs(spinner!.x + spinner!.width / 2 - check!.x - check!.width / 2),
  ).toBeLessThan(1);
});

test("页面元素引用、附件删除与窄侧边栏布局", async ({ page }) => {
  await installHarness(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/sidepanel.html");
  for (const label of ["选择页面元素", "添加附件"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await button.hover();
    await expect(page.getByRole("tooltip")).toHaveText(label);
    await page.mouse.move(0, 0, { steps: 5 });
    await expect(page.getByRole("tooltip")).toBeHidden();
  }
  await page.getByRole("button", { name: "选择页面元素", exact: true }).click();
  await expect(page.getByText("<button> 提交", { exact: true })).toBeVisible();
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "context.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("测试附件"),
    });
  await expect(page.getByText("context.txt", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "移除 context.txt", exact: true })
    .click();
  await expect(page.getByText("context.txt", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.find(
            (message) => message.type === "agent:start",
          )?.payload?.userMessage,
      ),
    )
    .toContain('selector="#submit"');
  await expectNoOverflow(page);
  await page.screenshot({ path: "test-results/sidepanel-narrow.png" });
});

test("输入法组合输入不会提前提交", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  const input = page.getByRole("textbox", { name: "任务内容" });
  await input.fill("中文任务");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  expect(
    await page.evaluate(
      () =>
        window.__harness.messages.filter(
          (message) => message.type === "agent:start",
        ).length,
    ),
  ).toBe(0);
  await input.dispatchEvent("compositionend");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__harness.messages.filter(
            (message) => message.type === "agent:start",
          ).length,
      ),
    )
    .toBe(1);
});

test("粘贴附件使用同一份附件状态并保留文件名展示", async ({ page }) => {
  await installHarness(page);
  await page.goto("/sidepanel.html");
  const input = page.getByRole("textbox", { name: "任务内容" });
  await input.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(
      new File(["粘贴的上下文"], "pasted.txt", { type: "text/plain" }),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByText("pasted.txt", { exact: true })).toBeVisible();
  await input.fill("读取附件");
  await input.press("Enter");
  await expect(
    page.getByText("读取附件" + "\n[附件: pasted.txt]", { exact: true }),
  ).toBeVisible();
});

test("流式公式结束后完整渲染且不产生页面错误", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installHarness(page);
  await page.goto("/sidepanel.html");
  await page.getByRole("textbox", { name: "任务内容" }).fill("输出公式");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  await emit(page, "message", "");
  await emit(page, "message_delta", "结果：$x^");
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await emit(page, "message_delta", "2 + y^2$\n\n$$\n\\frac{1}{2}");
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await emit(page, "message_delta", "\n$$");
  await emit(page, "assistant_turn_done", {});
  await emit(page, "done", {});
  await expect(page.locator(".katex")).toHaveCount(2);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/sidepanel-formulas.png" });
});

test("暗色审批展示和设置布局", async ({ page }) => {
  await installHarness(page, { themeMode: "dark" });
  await page.goto("/sidepanel.html");
  await emit(page, "tool_call", {
    id: "js-1",
    name: "execute_js",
    args: JSON.stringify({
      description: "统计页面中的订单金额",
      code: "const total = [25, 30, 45].reduce((sum, price) => sum + price, 0);\nconsole.log(total);",
    }),
    needsPermission: true,
  });
  await page.getByRole("button", { name: /Run JS/ }).click();
  await expect(
    page.getByRole("button", { name: "允许", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/sidepanel-approval-dark.png" });
  await page.goto("/options.html");
  await expect(
    page.getByRole("heading", { name: "NekoPilot 设置" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 900 });
  await mkdir("artifacts/ui", { recursive: true });
  await page.screenshot({
    path: "artifacts/ui/options-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() =>
    (window.chrome.storage.local.set as unknown as (values: object) => void)({
      themeMode: "light",
    }),
  );
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.screenshot({
    path: "artifacts/ui/options-light.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("思考过程与多步工具的混合时间线展示", async ({ page }) => {
  await installHarness(page, {
    themeMode: "light",
    chatLogs: [
      {
        id: 1,
        type: "user",
        content: "核对订单总额，确认后提交订单。",
        timestamp: 1,
      },
      {
        id: 2,
        type: "thinking",
        content:
          "先读取订单信息，再核对金额。\n\n提交会修改页面数据，需要等待你的批准。",
        thinkingDone: true,
        thinkSeconds: 2,
        timestamp: 2,
      },
      {
        id: 3,
        type: "tool_call",
        toolName: "read_page_interactive",
        toolCallId: "read-1",
        content: "{}",
        toolResult: "找到 3 笔订单和提交按钮。",
        toolSuccess: true,
        timestamp: 3,
      },
      {
        id: 4,
        type: "tool_call",
        toolName: "execute_js",
        toolCallId: "js-1",
        content: JSON.stringify({
          description: "核对订单总额",
          code: "const total = [25, 30, 45]\n  .reduce((sum, value) => sum + value, 0);\nconsole.log({ total });",
        }),
        toolResult: '{"total":100,"count":3}',
        toolSuccess: true,
        timestamp: 4,
      },
      {
        id: 5,
        type: "tool_call",
        toolName: "click",
        toolCallId: "click-1",
        content: '{"selector":"#submit-order"}',
        needsPermission: true,
        timestamp: 5,
      },
    ],
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/sidepanel.html");
  const group = page.getByRole("button", { name: "4 steps", exact: true });
  if ((await group.getAttribute("aria-expanded")) === "false")
    await group.click();
  await page.getByRole("button", { name: /已思考 2 秒/ }).click();
  await expect(
    page.getByText("先读取订单信息，再核对金额。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Run JS/ }).click();
  await expect(
    page.getByRole("tab", { name: "结果", exact: true }),
  ).toBeVisible();
  await expect(page.locator("code:visible")).toContainText('"total": 100');
  await expect(
    page.getByRole("button", { name: "允许", exact: true }),
  ).toBeVisible();
  await expect(group).not.toContainText("待审批");
  await expect(page.getByText("待审批", { exact: true })).toHaveCount(1);
  await expectNoOverflow(page);
  await mkdir("artifacts/ui", { recursive: true });
  await page.screenshot({
    path: "artifacts/ui/thinking-tools-light.png",
    animations: "disabled",
  });
});

for (const theme of ["light", "dark"]) {
  test(`多步工具详情标签页与审批布局：${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installHarness(page, {
      themeMode: theme,
      chatLogs: [
        {
          id: 1,
          type: "user",
          content: "汇总订单金额，然后点击提交订单。",
          timestamp: 1,
        },
        {
          id: 2,
          type: "tool_call",
          toolName: "read_page_interactive",
          toolCallId: "read-1",
          content: "{}",
          toolResult: "找到 3 笔订单和提交按钮。",
          toolSuccess: true,
          timestamp: 2,
        },
        {
          id: 3,
          type: "tool_call",
          toolName: "find_element",
          toolCallId: "find-1",
          content: '{"text":"提交订单"}',
          toolResult: '{"selector":"#submit-order","text":"提交订单"}',
          toolSuccess: true,
          timestamp: 3,
        },
        {
          id: 4,
          type: "tool_call",
          toolName: "execute_js",
          toolCallId: "js-1",
          content: JSON.stringify({
            description: "汇总 3 笔订单金额",
            code: "const amounts = [25, 30, 45];\nconst total = amounts.reduce(\n  (sum, amount) => sum + amount,\n  0,\n);\nconsole.log({ total });",
          }),
          toolResult: '{"total":100,"count":3}',
          toolSuccess: true,
          timestamp: 4,
        },
        {
          id: 5,
          type: "tool_call",
          toolName: "click",
          toolCallId: "click-1",
          content: '{"selector":"#submit-order"}',
          needsPermission: true,
          timestamp: 5,
        },
      ],
    });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto("/sidepanel.html");
    const group = page.getByRole("button", { name: "4 steps", exact: true });
    await expect(group).toContainText("4 个步骤");
    await expect(group).not.toContainText("已完成");
    if ((await group.getAttribute("aria-expanded")) === "false")
      await group.click();
    await page.getByRole("button", { name: /Run JS/ }).click();
    await expect(
      page.getByRole("tab", { name: "结果", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "代码", exact: true }).click();
    await expect(page.locator("code:visible")).toContainText("const amounts");
    await page.getByRole("button", { name: /Click/ }).click();
    await expect(
      page.getByRole("button", { name: "允许", exact: true }),
    ).toBeVisible();
    await expect(group).not.toContainText("待审批");
    await expect(page.getByText("待审批", { exact: true })).toHaveCount(1);
    await expectNoOverflow(page);
    await mkdir("artifacts/ui", { recursive: true });
    await page.screenshot({
      path: `artifacts/ui/multi-tools-${theme}.png`,
      animations: "disabled",
    });
    await page.getByRole("tab", { name: "代码", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "结果", exact: true }).first(),
    ).toHaveAttribute("aria-selected", "true");
    await page.screenshot({
      path: `artifacts/ui/multi-tools-result-${theme}.png`,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 320, height: 800 });
    await expectNoOverflow(page);
    await group.click();
    await expect(page.getByRole("button", { name: /Run JS/ })).toHaveCount(0);
    await expect(group).toContainText("待审批");
    await expect(page.getByText("待审批", { exact: true })).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}
