// NekoPilot — Background Service Worker
// 管理 CDP 连接、消息路由、Agent 执行

import { CdpManager } from "./cdp";
import { ToolExecutor } from "../tools/executor";
import { AgentLoop } from "../agent/loop";
import type { AgentConfig, ChatMessage } from "../agent/types";

const cdp = new CdpManager();
const tools = new ToolExecutor(cdp);

let agentLoop: AgentLoop | null = null;
let conversationHistory: ChatMessage[] = [];

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
    // ── CDP 相关 ──
    case "cdp:attach": {
      const tab = await getActiveTab();
      await cdp.attach(tab.id!);
      return { ok: true };
    }
    case "cdp:detach": {
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
      const { userMessage, config } = message.payload as {
        userMessage: string;
        config: AgentConfig;
      };
      const tab = await getActiveTab();
      // 始终重连到当前活动标签页
      try { await cdp.detach(); } catch { /* 未连接时忽略 */ }
      await cdp.attach(tab.id!);
      conversationHistory.push({ role: "user", content: userMessage });
      agentLoop = new AgentLoop(tools, config, (event) => {
        chrome.runtime.sendMessage({ type: "agent:event", payload: event }).catch(() => {});
      });
      const { text, messages } = await agentLoop.run(conversationHistory);
      conversationHistory = messages;
      agentLoop = null;
      return { result: text };
    }
    case "agent:stop": {
      if (agentLoop) {
        agentLoop.abort();
        agentLoop = null;
      }
      // 清理页面上残留的 click/scroll 标记
      tools.removeClickMarker().catch(() => {});
      return { ok: true };
    }
    case "agent:reset": {
      conversationHistory = [];
      if (agentLoop) {
        agentLoop.abort();
        agentLoop = null;
      }
      tools.removeClickMarker().catch(() => {});
      return { ok: true };
    }
    case "agent:truncateBeforeUserTurn": {
      // 截断对话历史到第 turnIndex 条 user 消息之前（用于重试）
      const { turnIndex } = message.payload as { turnIndex: number };
      let userCount = 0;
      let cutAt = conversationHistory.length;
      for (let i = 0; i < conversationHistory.length; i++) {
        if (conversationHistory[i].role === "user") {
          if (userCount === turnIndex) { cutAt = i; break; }
          userCount++;
        }
      }
      conversationHistory = conversationHistory.slice(0, cutAt);
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
      // 始终重连到当前活动标签页
      const tab = await getActiveTab();
      try { await cdp.detach(); } catch { /* 忽略 */ }
      await cdp.attach(tab.id!);
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
          }
        );
        if (check.result.value !== undefined) {
          // 清理
          await cdp.send("Runtime.evaluate", {
            expression: "delete window.__nekopilotPickResult; delete window.__nekopilotPicker;",
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
          }
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
