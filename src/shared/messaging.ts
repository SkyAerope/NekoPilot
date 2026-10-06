// Side Panel 消息钩子 — 与 background service worker 通信
import type { AgentConfig } from "../agent/types";
import type { ChatAttachment } from "./attachments";

export type AgentStartPayload = {
  readonly userMessage: string;
  readonly config: AgentConfig;
  readonly attachments?: readonly ChatAttachment[];
  readonly messageId?: number;
  readonly retryTurnIndex?: number;
};

export function sendAgentStart(payload: AgentStartPayload): Promise<unknown> {
  return sendMessage("agent:start", payload);
}

export function sendMessage<T = unknown>(
  type: string,
  payload?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response as T);
      }
    });
  });
}
