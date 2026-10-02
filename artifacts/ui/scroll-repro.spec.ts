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

for (const mode of ["empty", "long", "tools"]) {
  test(`滚动复现诊断：${mode}`, async ({ page }) => {
    const chatLogs = mode === "empty" ? [] : mode === "long"
      ? Array.from({ length: 30 }, (_, index) => ({ id: index + 1, type: index % 2 ? "assistant" : "user", content: `消息 ${index + 1}\n` + "用于检查侧边栏滚动布局。\n".repeat(6), timestamp: index + 1 }))
      : [{ id: 1, type: "user", content: "检查工具详情", timestamp: 1 }, { id: 2, type: "tool_call", toolName: "execute_js", toolCallId: "js-1", content: JSON.stringify({ code: "console.log(1);\n".repeat(100), description: "检查代码" }), toolResult: "完成\n".repeat(100), toolSuccess: true, timestamp: 2 }];
    await installHarness(page, { chatLogs });
    await page.goto("/sidepanel.html");
    await expect(page.getByRole("textbox", { name: "任务内容" })).toBeVisible();
    await page.waitForTimeout(500);
    const capture = async (stage: string) => {
      const metrics = await page.evaluate(() => {
        const box = document.querySelector("#root > div > div") as HTMLElement;
        const root = document.scrollingElement!;
        const rect = box.getBoundingClientRect();
        return { viewport: innerHeight, pageHeight: root.scrollHeight, pageTop: root.scrollTop, chatHeight: box.clientHeight, chatScrollHeight: box.scrollHeight, chatTop: box.scrollTop, chatRect: { top: rect.top, bottom: rect.bottom }, overflowing: Array.from(document.querySelectorAll("body *")).map(element => ({ tag: element.tagName, className: element.getAttribute("class"), text: element.textContent?.slice(0, 70), bottom: element.getBoundingClientRect().bottom, position: getComputedStyle(element).position })).filter(element => element.bottom > innerHeight + 5).slice(-15) };
      });
      console.log(mode, stage, JSON.stringify(metrics));
      await page.screenshot({ path: `artifacts/ui/scroll-${mode}-${stage}.png` });
    };
    await capture("initial");
    if (mode === "tools") {
      await page.getByRole("button", { name: /Run JS/ }).click();
      await page.getByRole("tab", { name: "代码", exact: true }).click();
      await capture("expanded");
      await page.getByRole("button", { name: /Run JS/ }).click();
      await capture("collapsed");
    }
    for (const label of ["添加附件", "选择页面元素"]) {
      await page.getByRole("button", { name: label, exact: true }).hover();
      await page.waitForTimeout(800);
      await capture(label === "添加附件" ? "attachment-hover" : label === "选择页面元素" ? "picker-hover" : "submit-hover");
    }
    await page.mouse.move(1, 1);
    await page.evaluate(() => { const box = document.querySelector("#root > div > div") as HTMLElement; box.scrollTop = box.scrollHeight; window.scrollTo(0, document.documentElement.scrollHeight); });
    await capture("bottom");
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll("button:has(> .sr-only)").forEach(element => { (element as HTMLElement).style.position = "relative"; }); });
    await capture("position-contained");
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(800);
  });
}

