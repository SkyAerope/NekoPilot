import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

type AgentEvent = { type: string; data: unknown };
type Harness = {
  storage: Record<string, unknown>;
  messages: { type: string; payload?: Record<string, unknown> }[];
  emit: (event: AgentEvent) => void;
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
      emit: (event) =>
        messageListeners.forEach((listener) =>
          listener({ type: "agent:event", payload: event }),
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
        sendMessage: (
          message: Harness["messages"][number],
          callback: (result: unknown) => void,
        ) => {
          messages.push(message);
          const result =
            message.type === "settings:get"
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
          queueMicrotask(() => callback(result));
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
