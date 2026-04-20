// NekoPilot — Background Service Worker
// 管理 CDP 连接、消息路由、Agent 执行

import { CdpManager } from "./cdp";
import { ToolExecutor } from "../tools/executor";
import { AgentLoop } from "../agent/loop";
import type { AgentConfig } from "../agent/types";

const cdp = new CdpManager();
const tools = new ToolExecutor(cdp);

let agentLoop: AgentLoop | null = null;

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
      if (!cdp.isAttached) {
        await cdp.attach(tab.id!);
      }
      agentLoop = new AgentLoop(tools, config, (event) => {
        // 将 agent 事件广播给 side panel
        chrome.runtime.sendMessage({ type: "agent:event", payload: event });
      });
      const result = await agentLoop.run(userMessage);
      agentLoop = null;
      return { result };
    }
    case "agent:stop": {
      if (agentLoop) {
        agentLoop.abort();
        agentLoop = null;
      }
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
      const tab = await getActiveTab();
      if (!cdp.isAttached) {
        await cdp.attach(tab.id!);
      }
      // 注入元素选择器到页面
      const pickScript = `
        (function() {
          if (window.__nekopilotPicker) return;
          window.__nekopilotPicker = true;

          const overlay = document.createElement('div');
          overlay.id = '__nekopilot-overlay';
          overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;cursor:crosshair;outline:none;';
          overlay.tabIndex = 0;
          document.body.appendChild(overlay);
          overlay.focus();

          const highlight = document.createElement('div');
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

            overlay.remove();
            highlight.remove();
            window.__nekopilotPicker = false;

            // 通过 window message 传回结果
            window.__nekopilotPickResult = info;
          });

          // ESC 取消
          overlay.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
              overlay.remove();
              highlight.remove();
              window.__nekopilotPicker = false;
              window.__nekopilotPickResult = null;
            }
          });

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
      // 超时
      await cdp.send("Runtime.evaluate", {
        expression:
          "document.getElementById('__nekopilot-overlay')?.remove(); delete window.__nekopilotPicker; delete window.__nekopilotPickResult;",
      });
      return { element: null, timeout: true };
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
