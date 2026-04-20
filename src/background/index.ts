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
