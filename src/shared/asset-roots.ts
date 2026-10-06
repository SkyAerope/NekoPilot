import { AssetStorageError, isScreenshotRef } from "./assets";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addScreenshot(ids: Set<string>, value: unknown): void {
  if (value === undefined) return;
  if (!isScreenshotRef(value))
    throw new AssetStorageError("截图引用损坏，取消回收");
  ids.add(value.id);
}

/** 读取失败或结构损坏不能解释为没有引用。旧 Base64 由迁移重新生成文件。 */
export async function readAssetRoots(): Promise<Set<string>> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get("chatLogs"),
    chrome.storage.session.get("conversationState"),
  ]);
  const ids = new Set<string>();
  const logs: unknown = local.chatLogs;
  if (logs !== undefined) {
    if (!Array.isArray(logs))
      throw new AssetStorageError("聊天日志损坏，取消回收");
    for (const entry of logs) {
      if (!record(entry)) throw new AssetStorageError("聊天记录损坏，取消回收");
      addScreenshot(ids, entry.screenshot);
    }
  }
  const state: unknown = session.conversationState;
  if (state !== undefined) {
    if (!record(state) || !Array.isArray(state.conversationHistory))
      throw new AssetStorageError("模型历史损坏，取消回收");
    for (const message of state.conversationHistory) {
      if (!record(message))
        throw new AssetStorageError("模型消息损坏，取消回收");
      if (typeof message.content === "string" || message.content === null)
        continue;
      if (!Array.isArray(message.content))
        throw new AssetStorageError("模型消息内容损坏，取消回收");
      for (const part of message.content) {
        if (!record(part))
          throw new AssetStorageError("模型消息部分损坏，取消回收");
        if (part.type === "screenshot") {
          if (part.screenshot === undefined)
            throw new AssetStorageError("模型截图引用缺失，取消回收");
          addScreenshot(ids, part.screenshot);
        }
      }
    }
  }
  return ids;
}
