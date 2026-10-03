// NekoPilot — Background Service Worker
// 管理 CDP 连接、消息路由、Agent 执行

import { CdpManager } from "./cdp";
import { ToolExecutor } from "../tools/executor";
import { AgentLoop } from "../agent/loop";
import type { AgentConfig, ChatMessage } from "../agent/types";
import type { TargetTab, TargetTabStatus } from "../shared/target-tab";
import { prependPageContext } from "../shared/page-context";

// 开发期自动热重载：`pnpm dev`（vite build --watch）每次重建后会写入 dist/reload.json，
// 这里轮询其时间戳，一旦变化就 chrome.runtime.reload() 自动重载整个扩展。
// __DEV_RELOAD__ 是 Vite 注入的编译期常量：生产构建（pnpm build）下为 false，
// 整个 if 块会被 tree-shaking 移除，生产产物里不存在任何这段代码，零运行时成本。
if (__DEV_RELOAD__) {
  let lastTs: number | null = null;
  setInterval(async () => {
    try {
      const res = await fetch(chrome.runtime.getURL("reload.json"), {
        cache: "no-store",
      });
      if (!res.ok) return;
      const { ts } = (await res.json()) as { ts: number };
      if (lastTs !== null && ts !== lastTs) {
        chrome.runtime.reload();
        return;
      }
      lastTs = ts;
    } catch {
      /* reload.json 尚未生成或读取失败时忽略 */
    }
  }, 1000);
}

const cdp = new CdpManager();
const tools = new ToolExecutor(cdp);

let agentLoop: AgentLoop | null = null;
let agentBusy = false;
let stopRequested = false;
let targetChanging = false;
let pickerBusy = false;
let targetTabId: number | null = null;
let targetPinned = false;
let targetPinPending: Promise<void> | null = null;
let targetRevision = 0;
const targetReady = chrome.storage.session
  .get(["targetTabId", "targetTabPinned"])
  .then((data) => {
    if (typeof data.targetTabId === "number") targetTabId = data.targetTabId;
    targetPinned = data.targetTabPinned === true;
  });

function describeTab(tab: chrome.tabs.Tab): TargetTab {
  return {
    id: tab.id!,
    title: tab.title || tab.url || "未命名标签页",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl,
    lastAccessed: tab.lastAccessed,
  };
}

async function getTargetTab(): Promise<chrome.tabs.Tab> {
  await Promise.all([targetReady, historyReady]);
  if (
    targetTabId === null ||
    (!targetPinned && conversationHistory.length === 0)
  )
    return getActiveTab();
  try {
    return await chrome.tabs.get(targetTabId);
  } catch {
    throw new Error("操作标签页已关闭，请在输入框下方切换标签页。");
  }
}

async function selectTargetTab(
  tab: chrome.tabs.Tab,
  pinTarget = false,
): Promise<void> {
  const nextPinned = targetPinned || pinTarget;
  if (targetTabId === tab.id && targetPinned === nextPinned) return;
  await chrome.storage.session.set({
    targetTabId: tab.id!,
    targetTabPinned: nextPinned,
  });
  if (targetTabId !== tab.id) tools.resetShortRefs();
  targetTabId = tab.id!;
  targetPinned = nextPinned;
}

async function getTargetStatus(hasMessages = false): Promise<TargetTabStatus> {
  const revision = targetRevision;
  await Promise.all([targetReady, historyReady]);
  const active = await getActiveTab().catch(() => null);
  // UI 中的失败消息也算对话；首次出现消息时固定当时跟随的页面。
  if (
    hasMessages &&
    revision === targetRevision &&
    !targetPinned &&
    conversationHistory.length === 0 &&
    !agentBusy &&
    !pickerBusy &&
    !targetChanging &&
    !targetPinPending &&
    active
  ) {
    targetPinPending = selectTargetTab(active, true);
    try {
      await targetPinPending;
    } finally {
      targetPinPending = null;
    }
  }
  await targetPinPending;
  const followingActive =
    !targetPinned &&
    conversationHistory.length === 0 &&
    !agentBusy &&
    !pickerBusy &&
    !targetChanging;
  const target =
    targetTabId === null || followingActive
      ? active
      : await chrome.tabs.get(targetTabId).catch(() => null);
  return {
    target: target ? describeTab(target) : null,
    active: active ? describeTab(active) : null,
    missing: !followingActive && targetTabId !== null && target === null,
    busy: agentBusy || targetChanging,
  };
}
let conversationHistory: ChatMessage[] = [];
/** 真正由用户发起的消息在 conversationHistory 中的索引（不含工具产生的 user 消息，例如截图） */
let userTurnIndices: number[] = [];
let userTurnTabs: (TargetTab | null)[] = [];
let pendingTabSwitch = false;

// MV3 service worker 会在空闲时被回收。若仅把对话历史放在内存里，SW 重启后历史
// 就丢了——这会造成"UI 还显示着历史，但实际请求里却没有历史"的不一致。
// 用 chrome.storage.session 持久化会话历史：跨 SW 重启保留，浏览器关闭时清空。
const SESSION_KEY = "conversationState";

/** SW 启动时尽快恢复内存中的会话历史 */
const historyReady: Promise<void> = (async () => {
  try {
    const data = await chrome.storage.session.get(SESSION_KEY);
    const state = data[SESSION_KEY] as
      | {
          conversationHistory?: ChatMessage[];
          userTurnIndices?: number[];
          userTurnTabs?: (TargetTab | null)[];
          pendingTabSwitch?: boolean;
        }
      | undefined;
    if (state) {
      if (Array.isArray(state.conversationHistory))
        conversationHistory = state.conversationHistory;
      if (Array.isArray(state.userTurnIndices))
        userTurnIndices = state.userTurnIndices;
      userTurnTabs = userTurnIndices.map(
        (_, index) => state.userTurnTabs?.[index] ?? null,
      );
      pendingTabSwitch = state.pendingTabSwitch === true;
    }
  } catch {
    /* storage.session 不可用时忽略，退回纯内存行为 */
  }
})();

function persistHistory(): void {
  chrome.storage.session
    .set({
      [SESSION_KEY]: {
        conversationHistory,
        userTurnIndices,
        userTurnTabs,
        pendingTabSwitch,
      },
    })
    .catch(() => {});
}

// 点击扩展图标时打开 side panel
chrome.action.onClicked.addListener((_tab) => {
  chrome.sidePanel.open({ windowId: _tab.windowId! });
});

// 处理来自 side panel / options 的消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err) }));
  return true; // 保持 sendResponse 通道
});

async function handleMessage(message: { type: string; payload?: unknown }) {
  switch (message.type) {
    case "target:list": {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs
          .filter((tab) => tab.id !== undefined && tab.id >= 0)
          .map(describeTab),
      };
    }
    case "target:status":
      return getTargetStatus(
        (message.payload as { hasMessages?: boolean } | undefined)
          ?.hasMessages === true,
      );
    case "target:switch": {
      if (agentBusy || targetChanging || pickerBusy)
        throw new Error("请先结束任务或元素选择，再切换标签页。");
      targetChanging = true;
      try {
        await Promise.all([targetReady, historyReady, targetPinPending]);
        const { tabId } = message.payload as { tabId: number };
        if (!Number.isInteger(tabId) || tabId < 0)
          throw new Error("无效的标签页。");
        const tab = await chrome.tabs.get(tabId);
        const previousTabId = targetTabId;
        await cdp.attach(tab.id!);
        await chrome.tabs.update(tab.id!, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        await selectTargetTab(tab, conversationHistory.length > 0);
        await historyReady;
        if (userTurnIndices.length > 0 && previousTabId !== tab.id) {
          pendingTabSwitch = true;
          persistHistory();
        }
        return { ...(await getTargetStatus()), busy: false };
      } finally {
        targetChanging = false;
      }
    }
    // ── CDP 相关 ──
    case "cdp:attach": {
      if (agentBusy) throw new Error("任务执行期间不能重新连接。");
      const tab = await getTargetTab();
      await cdp.attach(tab.id!);
      await selectTargetTab(tab);
      return { ok: true };
    }
    case "cdp:detach": {
      if (agentBusy) throw new Error("请先停止任务，再断开连接。");
      await cdp.detach();
      return { ok: true };
    }
    case "cdp:status": {
      return { attached: cdp.isAttached };
    }

    // ── Tool 手动测试 ──
    case "tool:execute": {
      const { name, params } = message.payload as {
        name: string;
        params: Record<string, unknown>;
      };
      const result = await tools.execute(name, params);
      return { result };
    }

    // ── Agent ──
    case "agent:start": {
      if (agentBusy || targetChanging || pickerBusy)
        throw new Error("上一个任务或页面选择尚未结束，请稍后重试。");
      agentBusy = true;
      stopRequested = false;
      try {
        await targetPinPending;
        const { userMessage, config, messageId } = message.payload as {
          userMessage: string;
          config: AgentConfig;
          messageId?: number;
        };
        const tab = await getTargetTab();
        await cdp.attach(tab.id!);
        await selectTargetTab(tab, true);
        await historyReady;
        const target = describeTab(tab);
        const previousTarget = userTurnTabs[userTurnIndices.length - 1];
        const firstTurn = userTurnIndices.length === 0;
        const switched =
          pendingTabSwitch ||
          (previousTarget != null && previousTarget.id !== target.id);
        const content =
          firstTurn || switched
            ? prependPageContext(userMessage, target, !firstTurn)
            : userMessage;
        userTurnIndices.push(conversationHistory.length);
        userTurnTabs.push(target);
        pendingTabSwitch = false;
        conversationHistory.push({ role: "user", content });
        persistHistory();
        if (typeof messageId === "number") {
          chrome.runtime
            .sendMessage({
              type: "target:bound",
              payload: { messageId, target, showChip: firstTurn || switched },
            })
            .catch(() => {});
        }
        tools.configureShortRefs(config.enableShortRefs !== false);
        tools.configureScreenshotScaling(
          config.screenshotScaleMode ?? "claude46",
          config.screenshotMaxLongEdge,
          config.screenshotMaxPixels,
        );
        tools.configureCodeExecution({
          enabled: config.enableCodeExecution !== false,
          timeoutMs:
            typeof config.codeExecutionTimeoutMs === "number"
              ? config.codeExecutionTimeoutMs
              : 1000,
          maxOutputChars:
            typeof config.codeExecutionMaxOutputChars === "number"
              ? config.codeExecutionMaxOutputChars
              : 6000,
        });
        agentLoop = new AgentLoop(tools, config, (event) => {
          chrome.runtime
            .sendMessage({ type: "agent:event", payload: event })
            .catch(() => {});
        });
        if (stopRequested) agentLoop.abort();
        try {
          const { text, messages } = await agentLoop.run(conversationHistory);
          conversationHistory = messages;
          persistHistory();
          agentLoop = null;
          return { result: text };
        } catch (err) {
          // 任何未在 loop 内捕获的异常：明确告知 UI，否则前端 running 会卡住或静默回到 idle
          // eslint-disable-next-line no-console
          console.error("[NekoPilot] agentLoop.run threw:", err);
          chrome.runtime
            .sendMessage({
              type: "agent:event",
              payload: { type: "error", data: `Agent crashed: ${String(err)}` },
            })
            .catch(() => {});
          chrome.runtime
            .sendMessage({
              type: "agent:event",
              payload: { type: "done", data: "" },
            })
            .catch(() => {});
          agentLoop = null;
          throw err;
        }
      } finally {
        agentBusy = false;
      }
    }
    case "agent:stop": {
      stopRequested = true;
      if (agentLoop) {
        agentLoop.abort();
        agentLoop = null;
      }
      // 清理页面上残留的 click/scroll 标记
      tools.removeClickMarker().catch(() => {});
      return { ok: true };
    }
    case "agent:reset": {
      if (agentBusy || targetChanging || pickerBusy)
        throw new Error("请先结束任务或页面选择，再新建对话。");
      targetChanging = true;
      // 清空前发出的状态请求不能在清空后重新固定目标。
      targetRevision++;
      try {
        await Promise.all([targetReady, historyReady, targetPinPending]);
        await chrome.storage.session.remove(["targetTabId", "targetTabPinned"]);
        targetTabId = null;
        targetPinned = false;
        await cdp.detach();
        conversationHistory = [];
        userTurnIndices = [];
        userTurnTabs = [];
        pendingTabSwitch = false;
        persistHistory();
        if (agentLoop) {
          agentLoop.abort();
          agentLoop = null;
        }
        tools.removeClickMarker().catch(() => {});
        tools.resetShortRefs();
        return { ok: true };
      } finally {
        targetChanging = false;
      }
    }
    case "agent:truncateBeforeUserTurn": {
      // 截断对话历史到第 turnIndex 个真用户消息之前（用于重试）
      const { turnIndex } = message.payload as { turnIndex: number };
      await historyReady;
      const cutAt = userTurnIndices[turnIndex] ?? conversationHistory.length;
      conversationHistory = conversationHistory.slice(0, cutAt);
      userTurnIndices = userTurnIndices.slice(0, turnIndex);
      userTurnTabs = userTurnTabs.slice(0, turnIndex);
      persistHistory();
      if (agentLoop) {
        agentLoop.abort();
        agentLoop = null;
      }
      tools.removeClickMarker().catch(() => {});
      return { ok: true, remaining: conversationHistory.length };
    }
    case "agent:approve": {
      agentLoop?.resolvePermission(true);
      return { ok: true };
    }
    case "agent:reject": {
      agentLoop?.resolvePermission(false);
      return { ok: true };
    }
    case "agent:setMode": {
      const { mode } = message.payload as { mode: "ask" | "auto" };
      agentLoop?.setPermissionMode(mode);
      return { ok: true };
    }

    // ── 设置 ──
    case "settings:get": {
      const data = await chrome.storage.local.get("settings");
      return data.settings ?? {};
    }
    case "settings:set": {
      await chrome.storage.local.set({ settings: message.payload });
      return { ok: true };
    }

    // ── 元素选择器 ──
    case "pick:start": {
      if (agentBusy || targetChanging || pickerBusy)
        throw new Error("请先结束任务或页面选择，再选择页面元素。");
      pickerBusy = true;
      try {
        const tab = await getTargetTab();
        const active = await getActiveTab();
        if (tab.id !== active.id)
          throw new Error(
            `请先切换到“${tab.title || tab.url || "操作标签页"}”`,
          );
        await cdp.attach(tab.id!);
        await selectTargetTab(tab);
        // 注入元素选择器到页面
        const pickScript = `
        (function() {
          if (window.__nekopilotPicker) return;
          window.__nekopilotPicker = true;

          const overlay = document.createElement('div');
          overlay.id = '__nekopilot-overlay';
          overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;cursor:crosshair;outline:none;';
          document.body.appendChild(overlay);

          const highlight = document.createElement('div');
          highlight.id = '__nekopilot-highlight';
          highlight.style.cssText = 'position:fixed;border:2px solid #a78bfa;background:rgba(167,139,250,0.15);pointer-events:none;z-index:2147483646;transition:all 0.05s;';
          document.body.appendChild(highlight);

          let lastEl = null;

          overlay.addEventListener('mousemove', function(e) {
            overlay.style.pointerEvents = 'none';
            const el = document.elementFromPoint(e.clientX, e.clientY);
            overlay.style.pointerEvents = 'auto';
            if (!el || el === lastEl) return;
            lastEl = el;
            const rect = el.getBoundingClientRect();
            highlight.style.left = rect.left + 'px';
            highlight.style.top = rect.top + 'px';
            highlight.style.width = rect.width + 'px';
            highlight.style.height = rect.height + 'px';
            // 更新 hover 信息供 sidepanel 轮询
            window.__nekopilotPickHover = {
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || '').trim().slice(0, 60)
            };
          });

          overlay.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            overlay.style.pointerEvents = 'none';
            const el = document.elementFromPoint(e.clientX, e.clientY);
            overlay.style.pointerEvents = 'auto';

            let info = null;
            if (el) {
              const rect = el.getBoundingClientRect();
              info = {
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                className: el.className || undefined,
                text: (el.textContent || '').trim().slice(0, 120),
                href: el.getAttribute('href') || undefined,
                type: el.getAttribute('type') || undefined,
                placeholder: el.getAttribute('placeholder') || undefined,
                role: el.getAttribute('role') || undefined,
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                selector: buildSelector(el),
              };
            }

            cleanup();
            window.__nekopilotPickResult = info;
          });

          function cleanup() {
            overlay.remove();
            highlight.remove();
            window.__nekopilotPicker = false;
            delete window.__nekopilotPickHover;
          }

          function buildSelector(el) {
            if (el.id) return '#' + el.id;
            let path = el.tagName.toLowerCase();
            if (el.className && typeof el.className === 'string') {
              path += '.' + el.className.trim().split(/\\s+/).join('.');
            }
            return path;
          }
        })()
      `;
        await cdp.send("Runtime.evaluate", {
          expression: pickScript,
          returnByValue: true,
        });

        // 轮询等待用户选择（最多 30 秒）
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const check = await cdp.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            {
              expression: "window.__nekopilotPickResult",
              returnByValue: true,
            },
          );
          if (check.result.value !== undefined) {
            // 清理
            await cdp.send("Runtime.evaluate", {
              expression:
                "delete window.__nekopilotPickResult; delete window.__nekopilotPicker;",
            });
            return { element: check.result.value };
          }
        }
        // 超时 — 清理 overlay 和 highlight
        await cdp.send("Runtime.evaluate", {
          expression:
            "document.getElementById('__nekopilot-overlay')?.remove(); document.getElementById('__nekopilot-highlight')?.remove(); delete window.__nekopilotPicker; delete window.__nekopilotPickResult; delete window.__nekopilotPickHover;",
        });
        return { element: null, timeout: true };
      } finally {
        pickerBusy = false;
      }
    }

    case "pick:cancel": {
      // 从 UI 取消选择
      try {
        await cdp.send("Runtime.evaluate", {
          expression:
            "document.getElementById('__nekopilot-overlay')?.remove(); document.getElementById('__nekopilot-highlight')?.remove(); window.__nekopilotPicker = false; window.__nekopilotPickResult = null; delete window.__nekopilotPickHover;",
        });
      } catch {
        // CDP 可能已断开
      }
      return { ok: true };
    }

    case "pick:hover": {
      // 返回当前 hover 的元素信息
      try {
        const check = await cdp.send<{ result: { value: unknown } }>(
          "Runtime.evaluate",
          {
            expression: "window.__nekopilotPickHover",
            returnByValue: true,
          },
        );
        return { hover: check.result.value ?? null };
      } catch {
        return { hover: null };
      }
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}
