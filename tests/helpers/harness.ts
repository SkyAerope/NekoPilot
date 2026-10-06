import type { Page } from "@playwright/test";
import type { TargetTab, TargetTabStatus } from "../../src/shared/target-tab";

type AgentEvent = { type: string; data: unknown };
type Harness = {
  storage: Record<string, unknown>;
  messages: { type: string; payload?: Record<string, unknown> }[];
  emit: (event: AgentEvent) => void;
  notifyTargetChanged: () => void;
  emitTabEvent: (type: string) => void;
  statusDelay?: number;
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

export const screenshotData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

export async function installHarness(
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
    const messageListeners = new Set<(message: unknown, sender: object, respond: (response: unknown) => void) => void>();
    const storageListeners = new Set<(changes: unknown) => void>();
    const messages: Harness["messages"] = [];
    const tabListeners = new Map<string, Set<() => void>>();
    const tabEvent = (type: string) => {
      const listeners = new Set<() => void>();
      tabListeners.set(type, listeners);
      return {
        addListener: (listener: () => void) => listeners.add(listener),
        removeListener: (listener: () => void) => listeners.delete(listener),
      };
    };
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
          listener({ type: "agent:event", payload: event }, {}, () => {}),
        ),
      notifyTargetChanged: () =>
        messageListeners.forEach((listener) =>
          listener({ type: "target:changed" }, {}, () => {}),
        ),
      emitTabEvent: (type) =>
        tabListeners.get(type)?.forEach((listener) => listener()),
      bindTarget: (messageId, target, showChip = true) =>
        messageListeners.forEach((listener) =>
          listener({
            type: "target:bound",
            payload: { messageId, target, showChip },
          }, {}, () => {}),
        ),
    };
    const chromeMock = {
      tabs: {
        onCreated: tabEvent("created"),
        onRemoved: tabEvent("removed"),
        onUpdated: tabEvent("updated"),
        onActivated: tabEvent("activated"),
      },
      runtime: {
        lastError: undefined,
        onMessage: {
          addListener: (listener: (message: unknown, sender: object, respond: (response: unknown) => void) => void) =>
            messageListeners.add(listener),
          removeListener: (listener: (message: unknown, sender: object, respond: (response: unknown) => void) => void) =>
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
          if (message.type === "target:status" && harness.statusDelay) {
            const snapshot = structuredClone(result);
            window.setTimeout(() => callback(snapshot), harness.statusDelay);
          } else if (
            message.type === "target:list" &&
            initialStorage.tabListDelay
          ) {
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
        session: { get: async () => ({}) },
        local: {
          onChanged: changed,
          get: (
            keys: string | string[],
            callback?: (result: Record<string, unknown>) => void,
          ) => {
            const result: Record<string, unknown> = {};
            for (const key of typeof keys === "string" ? [keys] : keys)
              result[key] = storage[key];
            if (callback) queueMicrotask(() => callback(result));
            return Promise.resolve(result);
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
            return Promise.resolve();
          },
          remove: (keys: string | string[]) => {
            for (const key of typeof keys === "string" ? [keys] : keys)
              delete storage[key];
            return Promise.resolve();
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

export async function emit(page: Page, type: string, data: unknown) {
  await page.evaluate((event) => window.__harness.emit(event), { type, data });
}
