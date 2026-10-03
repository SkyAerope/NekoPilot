import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Bot,
  Settings,
  MessageSquarePlus,
  Copy,
  Pencil,
  RotateCcw,
  FastForward,
  Hand,
  MousePointer2,
  Paperclip,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Message,
  MessageContent,
  MessageActions,
  MessageAction,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";
import { MarkdownMessage } from "./markdown";
import { IconAction, ReferenceChip, WorkingIndicator } from "./controls";
import { StepsGroup } from "./timeline";
import { useBottomScroll } from "./use-bottom-scroll";
import {
  type LogEntry,
  type PickedElement,
  type Attachment,
  groupLogs,
  groupIntoTurns,
  getToolLabel,
  formatTokens,
  finishThinking,
} from "./model";
import { sendMessage } from "../shared/messaging";
import type { AgentEvent } from "../agent/types";
import type { TargetTabBinding, TargetTabStatus } from "../shared/target-tab";
import { TabSelector } from "./tab-selector";
import { TabIcon } from "./tab-icon";

let logIdCounter = 0;

function getErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^(?:Error:\s*)+/,
    "",
  );
}

export default function App() {
  const [input, setInput] = useState("");
  const [editingMessage, setEditingMessage] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [targetStatus, setTargetStatus] = useState<TargetTabStatus | null>(
    null,
  );
  const [targetError, setTargetError] = useState<string | null>(null);
  const [targetStatusError, setTargetStatusError] = useState<{
    message: string;
    needsReload: boolean;
  } | null>(null);
  const [switchingTab, setSwitchingTab] = useState(false);
  const targetMismatch = Boolean(
    targetStatus?.target && targetStatus.target.id !== targetStatus.active?.id,
  );
  const targetTitle = targetStatus?.target?.title || "";
  const truncatedTargetTitle =
    Array.from(targetTitle).length > 20
      ? `${Array.from(targetTitle).slice(0, 20).join("")}...`
      : targetTitle;
  const [autoMode, setAutoMode] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickHover, setPickHover] = useState<{
    tag: string;
    text: string;
  } | null>(null);
  const [pickedElements, setPickedElements] = useState<PickedElement[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [elementTextLimit, setElementTextLimit] = useState(128);
  /** 最近一次 LLM 响应的 prompt token 数——代表"当前上下文占用"。
   *  每轮请求都会刷新，UI 把它显示在工具栏让用户知道还剩多少预算。 */
  const [promptTokens, setPromptTokens] = useState<number | null>(null);
  const [cacheInfo, setCacheInfo] = useState<{
    creation: number;
    read: number;
  } | null>(null);
  const logsScroll = useBottomScroll(logs);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 恢复持久化的对话记录：侧边栏关闭再打开时，React state 会重置，
  // 但 background 仍保留 conversationHistory，会导致"UI 清空但请求仍带历史"。
  // 这里把 UI 的 logs 也持久化下来并在打开时恢复，使两端保持一致。
  const logsLoadedRef = useRef(false);

  // 加载持久化设置 + 历史对话
  useEffect(() => {
    chrome.storage.local.get(
      ["autoMode", "settings", "chatLogs", "chatMeta"],
      (data) => {
        if (data.autoMode !== undefined) setAutoMode(data.autoMode);
        if (data.settings?.elementTextLimit != null)
          setElementTextLimit(data.settings.elementTextLimit);
        if (Array.isArray(data.chatLogs) && data.chatLogs.length > 0) {
          setLogs(data.chatLogs as LogEntry[]);
          // 恢复 logIdCounter，避免新条目 id 与已恢复条目冲突
          const maxId = (data.chatLogs as LogEntry[]).reduce(
            (m, l) => Math.max(m, l.id),
            0,
          );
          if (maxId > logIdCounter) logIdCounter = maxId;
        }
        if (data.chatMeta) {
          if (typeof data.chatMeta.promptTokens === "number")
            setPromptTokens(data.chatMeta.promptTokens);
          if (data.chatMeta.cacheInfo) setCacheInfo(data.chatMeta.cacheInfo);
        }
        logsLoadedRef.current = true;
      },
    );
  }, []);

  // 持久化对话记录（防抖），让关闭/重开侧边栏后仍能保留历史
  useEffect(() => {
    if (!logsLoadedRef.current) return;
    const timer = setTimeout(() => {
      chrome.storage.local.set({
        chatLogs: logs,
        chatMeta: { promptTokens, cacheInfo },
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [logs, promptTokens, cacheInfo]);

  // 轮询元素选择器 hover 信息
  useEffect(() => {
    if (!picking) {
      setPickHover(null);
      return;
    }
    const timer = setInterval(async () => {
      try {
        const res = await sendMessage<{
          hover: { tag: string; text: string } | null;
        }>("pick:hover");
        setPickHover(res.hover);
      } catch {
        setPickHover(null);
      }
    }, 300);
    return () => clearInterval(timer);
  }, [picking]);

  // 监听 agent 事件
  useEffect(() => {
    const listener = (message: {
      type: string;
      payload?: AgentEvent | TargetTabBinding;
    }) => {
      if (message.type === "target:bound" && message.payload) {
        const binding = message.payload as TargetTabBinding;
        setLogs((previous) =>
          previous.map((entry) =>
            entry.id === binding.messageId
              ? {
                  ...entry,
                  targetTab: binding.target,
                  showTargetTabChip: binding.showChip,
                }
              : entry,
          ),
        );
        return;
      }
      if (message.type !== "agent:event" || !message.payload) return;
      const event = message.payload as AgentEvent;

      // 阶段切换和终止都要收尾，不能依赖模型发送闭合标签或流正常结束。
      if (
        [
          "message",
          "tool_call_streaming",
          "tool_call",
          "thinking",
          "done",
          "error",
        ].includes(event.type)
      ) {
        setLogs((prev) => finishThinking(prev));
      }

      if (event.type === "done") {
        setRunning(false);
        return;
      }

      if (event.type === "tool_call_streaming") {
        setLogs((prev) => {
          if (prev[prev.length - 1]?.type === "pending") return prev;
          return [
            ...prev,
            {
              id: ++logIdCounter,
              type: "pending",
              content:
                typeof event.data === "string"
                  ? event.data
                  : "正在生成工具调用…",
              timestamp: Date.now(),
            },
          ];
        });
        return;
      }

      if (event.type === "message") {
        setLogs((prev) => [
          ...prev.filter((log) => log.type !== "pending"),
          {
            id: ++logIdCounter,
            type: "assistant",
            content:
              typeof event.data === "string"
                ? event.data
                : JSON.stringify(event.data),
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      if (event.type === "message_delta") {
        const delta = typeof event.data === "string" ? event.data : "";
        const OPEN_TAG = /<think(?:ing)?>/i;
        const CLOSE_TAG = /<\/think(?:ing)?>/i;
        setLogs((prev) => {
          const lastThink = prev.findLastIndex((l) => l.type === "thinking");
          const lastAsst = prev.findLastIndex((l) => l.type === "assistant");
          // 情况 A：当前正处在未完成的 thinking 中（thinking 在 assistant 之后）
          if (
            lastThink !== -1 &&
            lastThink > lastAsst &&
            !prev[lastThink].thinkingDone
          ) {
            const old = prev[lastThink];
            const nextContent = old.content + delta;
            const closeMatch = nextContent.match(CLOSE_TAG);
            if (!closeMatch) {
              const updated = [...prev];
              updated[lastThink] = { ...old, content: nextContent };
              return updated;
            }
            // 检测到结束：截断 thinking 内容，剩余部分作为新的 assistant entry
            const closeIdx = closeMatch.index!;
            const closeLen = closeMatch[0].length;
            const thinkPart = nextContent.slice(0, closeIdx + closeLen);
            const tailPart = nextContent.slice(closeIdx + closeLen);
            const updated = [...prev];
            updated[lastThink] = {
              ...old,
              content: thinkPart,
              thinkingDone: true,
              thinkSeconds: Math.max(
                1,
                Math.round((Date.now() - old.timestamp) / 1000),
              ),
            };
            if (tailPart) {
              updated.push({
                id: ++logIdCounter,
                type: "assistant",
                content: tailPart,
                timestamp: Date.now(),
              });
            }
            return updated;
          }
          // 情况 B：当前在 assistant 中
          if (lastAsst === -1) return prev;
          const old = prev[lastAsst];
          const nextContent = old.content + delta;
          // 触发条件：出现闭合标签 </think(ing)>，或出现开始标签 <think(ing)>
          // — 闭合标签：之前的全部内容视为思考内容
          // — 仅开始标签：转入未完成 thinking，等待后续 delta 出现闭合
          const closeMatch = nextContent.match(CLOSE_TAG);
          const openMatch = nextContent.match(OPEN_TAG);
          if (closeMatch) {
            const closeIdx = closeMatch.index!;
            const closeLen = closeMatch[0].length;
            const thinkPart = nextContent.slice(0, closeIdx + closeLen);
            const tailPart = nextContent.slice(closeIdx + closeLen);
            const updated = [...prev];
            const now = Date.now();
            updated[lastAsst] = {
              ...old,
              type: "thinking",
              content: thinkPart,
              thinkingDone: true,
              thinkSeconds: Math.max(
                1,
                Math.round((now - old.timestamp) / 1000),
              ),
            };
            if (tailPart) {
              updated.push({
                id: ++logIdCounter,
                type: "assistant",
                content: tailPart,
                timestamp: now,
              });
            }
            return updated;
          }
          if (openMatch) {
            // 仅有开始标签且未见闭合：把 entry 转为 thinking，开始标签前的内容若有则保留为前置 assistant
            const openIdx = openMatch.index!;
            const before = nextContent.slice(0, openIdx);
            const fromOpen = nextContent.slice(openIdx);
            const updated = [...prev];
            const now = Date.now();
            if (before) {
              updated[lastAsst] = { ...old, content: before };
            } else {
              updated.splice(lastAsst, 1);
            }
            updated.push({
              id: ++logIdCounter,
              type: "thinking",
              content: fromOpen,
              timestamp: now,
              thinkingDone: false,
            });
            return updated;
          }
          // 普通 assistant 追加
          const updated = [...prev];
          updated[lastAsst] = { ...old, content: nextContent };
          return updated;
        });
        return;
      }

      if (event.type === "tool_call") {
        const data = event.data as {
          name: string;
          args: string;
          id: string;
          needsPermission?: boolean;
        };
        setLogs((prev) => [
          ...prev.filter((log) => log.type !== "pending"),
          {
            id: ++logIdCounter,
            type: "tool_call",
            content: data.args,
            toolName: data.name,
            toolCallId: data.id,
            needsPermission: data.needsPermission,
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      if (event.type === "tool_result") {
        const data = event.data as {
          name: string;
          result: { success: boolean; data?: unknown; error?: string };
          id: string;
        };
        setLogs((prev) =>
          prev.map((log) => {
            if (log.type === "tool_call" && log.toolCallId === data.id) {
              const resultData = data.result.data ?? data.result.error;
              // 字符串结果直接保留（避免 JSON.stringify 把 \n 转义为字面量）
              const formatted =
                resultData === undefined
                  ? "done"
                  : typeof resultData === "string"
                    ? resultData
                    : JSON.stringify(resultData, null, 2);
              const shotInfo =
                data.name === "screenshot" && data.result.success
                  ? typeof data.result.data === "string"
                    ? { data: data.result.data as string, mime: "image/png" }
                    : (data.result.data as { data: string; mime: string })
                  : null;
              // 工具 runtime 没抛错并不代表语义上成功：例如 find_element 返回
              // "no_results: ..." 字符串、或对象内 status === "no_results" / "error"。
              // 这里识别这些"软失败"，让 UI 显示叉叉。
              let semanticSuccess = data.result.success;
              if (semanticSuccess) {
                const d = data.result.data;
                if (typeof d === "string") {
                  if (/^(no_results|not_found|error)\b/i.test(d.trim()))
                    semanticSuccess = false;
                } else if (d && typeof d === "object") {
                  const status = (d as { status?: unknown }).status;
                  if (
                    typeof status === "string" &&
                    /^(no_results|not_found|error|failed)$/i.test(status)
                  ) {
                    semanticSuccess = false;
                  }
                }
              }
              return {
                ...log,
                toolResult: formatted,
                toolSuccess: semanticSuccess,
                screenshotData: shotInfo?.data,
                screenshotMime: shotInfo?.mime,
              };
            }
            return log;
          }),
        );
        return;
      }

      if (event.type === "screenshots_pruned") {
        const ids = (event.data as { ids: string[] }).ids ?? [];
        setLogs((prev) =>
          prev.map((log) =>
            log.toolCallId && ids.includes(log.toolCallId)
              ? { ...log, prunedFromContext: true }
              : log,
          ),
        );
        return;
      }

      if (event.type === "thinking") {
        const text =
          typeof event.data === "string"
            ? event.data
            : JSON.stringify(event.data);
        setLogs((prev) => [
          ...prev,
          {
            id: ++logIdCounter,
            type: "thinking",
            content: text,
            timestamp: Date.now(),
            thinkingDone: false,
          },
        ]);
        return;
      }

      if (event.type === "thinking_delta") {
        const delta = typeof event.data === "string" ? event.data : "";
        setLogs((prev) => {
          const lastIdx = prev.findLastIndex((l) => l.type === "thinking");
          if (lastIdx === -1) return prev;
          const updated = [...prev];
          const old = updated[lastIdx];
          const nextContent = old.content + delta;
          // 检测到 </think> 闭合：标记完成时间
          let thinkingDone = old.thinkingDone;
          let thinkSeconds = old.thinkSeconds;
          if (!thinkingDone && /<\/think>/i.test(nextContent)) {
            thinkingDone = true;
            thinkSeconds = Math.max(
              1,
              Math.round((Date.now() - old.timestamp) / 1000),
            );
          }
          updated[lastIdx] = {
            ...old,
            content: nextContent,
            thinkingDone,
            thinkSeconds,
          };
          return updated;
        });
        return;
      }

      if (event.type === "assistant_turn_done") {
        setLogs((prev) => finishThinking(prev));
        return;
      }

      if (event.type === "usage") {
        const u = event.data as
          | {
              promptTokens?: number;
              totalTokens?: number;
              cacheCreationInputTokens?: number;
              cacheReadInputTokens?: number;
            }
          | undefined;
        // prompt_tokens 反映上一轮请求的上下文大小，最能代表"当前占了多少上下文"。
        // 没有时兜底用 totalTokens。
        const n =
          typeof u?.promptTokens === "number" && u.promptTokens > 0
            ? u.promptTokens
            : typeof u?.totalTokens === "number"
              ? u.totalTokens
              : null;
        if (n !== null) setPromptTokens(n);
        // 缓存命中信息
        if (u?.cacheCreationInputTokens || u?.cacheReadInputTokens) {
          setCacheInfo({
            creation: u.cacheCreationInputTokens ?? 0,
            read: u.cacheReadInputTokens ?? 0,
          });
        } else {
          setCacheInfo(null);
        }
        return;
      }

      if (event.type === "error") {
        setLogs((prev) => [
          ...prev,
          {
            id: ++logIdCounter,
            type: "error",
            content:
              typeof event.data === "string"
                ? event.data
                : JSON.stringify(event.data),
            timestamp: Date.now(),
          },
        ]);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const hasMessages = logs.some(
    (log) => log.type === "user" || log.type === "assistant",
  );
  const hasMessagesRef = useRef(hasMessages);
  hasMessagesRef.current = hasMessages;
  const targetRefreshRef = useRef<Promise<void> | null>(null);
  const targetRefreshRevisionRef = useRef(0);
  const targetPinRequestedRef = useRef(false);
  const targetStatusMountedRef = useRef(false);
  const refreshTargetStatus = useCallback(async (pinFromMessages = false) => {
    targetPinRequestedRef.current ||= pinFromMessages;
    targetRefreshRevisionRef.current++;
    if (targetRefreshRef.current) return targetRefreshRef.current;
    // 合并同一轮事件；查询途中发生变化时丢弃旧结果，再取一次最新状态。
    const request = Promise.resolve().then(async () => {
      let revision: number;
      do {
        revision = targetRefreshRevisionRef.current;
        // 仅在恢复历史或出现首条消息时固定目标，状态通知本身不应重新固定刚重置的目标。
        const pinTarget = targetPinRequestedRef.current;
        targetPinRequestedRef.current = false;
        try {
          const status = await sendMessage<TargetTabStatus>("target:status", {
            hasMessages:
              pinTarget && logsLoadedRef.current && hasMessagesRef.current,
          });
          if (!targetStatusMountedRef.current) return;
          if (revision !== targetRefreshRevisionRef.current) continue;
          setTargetStatus(status);
          setTargetStatusError(null);
        } catch (error) {
          if (!targetStatusMountedRef.current) return;
          if (revision !== targetRefreshRevisionRef.current) continue;
          const message = getErrorMessage(error);
          const needsReload = message === "Unknown message type: target:status";
          setTargetStatus(null);
          setTargetStatusError({
            message: needsReload
              ? "扩展后台仍是旧版本，请重新加载扩展。"
              : message,
            needsReload,
          });
        }
      } while (revision !== targetRefreshRevisionRef.current);
    });
    targetRefreshRef.current = request;
    try {
      await request;
    } finally {
      targetRefreshRef.current = null;
    }
  }, []);

  useEffect(() => {
    setPickedElements([]);
  }, [targetStatus?.target?.id]);

  // 空对话跟随活动页；出现消息后，后台保持操作目标。
  useEffect(() => {
    targetStatusMountedRef.current = true;
    void refreshTargetStatus(true);
    const refresh = () => void refreshTargetStatus();
    const onMessage = (message: { type: string }) => {
      if (message.type === "target:changed") refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    document.addEventListener("visibilitychange", onVisible);
    chrome.tabs?.onCreated?.addListener(refresh);
    chrome.tabs?.onActivated?.addListener(refresh);
    chrome.tabs?.onUpdated?.addListener(refresh);
    chrome.tabs?.onRemoved?.addListener(refresh);
    chrome.windows?.onFocusChanged?.addListener(refresh);
    return () => {
      targetStatusMountedRef.current = false;
      chrome.runtime.onMessage.removeListener(onMessage);
      document.removeEventListener("visibilitychange", onVisible);
      chrome.tabs?.onCreated?.removeListener(refresh);
      chrome.tabs?.onActivated?.removeListener(refresh);
      chrome.tabs?.onUpdated?.removeListener(refresh);
      chrome.tabs?.onRemoved?.removeListener(refresh);
      chrome.windows?.onFocusChanged?.removeListener(refresh);
    };
  }, [refreshTargetStatus, hasMessages]);

  const setAutoModeAndPersist = useCallback((value: boolean) => {
    setAutoMode(value);
    chrome.storage.local.set({ autoMode: value });
    // 实时同步给正在运行的 agent
    sendMessage("agent:setMode", { mode: value ? "auto" : "ask" }).catch(
      () => {},
    );
  }, []);

  const handleSwitchTab = useCallback(
    async (tabId: number) => {
      setSwitchingTab(true);
      setTargetError(null);
      try {
        await sendMessage<TargetTabStatus>("target:switch", {
          tabId: Number(tabId),
        });
        await refreshTargetStatus();
        setPickedElements([]);
      } catch (error) {
        setTargetError(getErrorMessage(error));
        void refreshTargetStatus();
      } finally {
        setSwitchingTab(false);
      }
    },
    [refreshTargetStatus],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (
      (!text && pickedElements.length === 0) ||
      editingMessage !== null ||
      running ||
      switchingTab ||
      targetStatus?.busy ||
      targetStatusError?.needsReload ||
      picking
    )
      return;

    const elementContext = pickedElements
      .map(
        (el) =>
          `[元素: <${el.tag}> selector="${el.selector}" text="${el.text}" rect=(${el.rect.x},${el.rect.y},${el.rect.w}x${el.rect.h}) center=(${Math.round(el.rect.x + el.rect.w / 2)},${Math.round(el.rect.y + el.rect.h / 2)})]`,
      )
      .join("\n");
    const attachmentNames = attachments.map((a) => a.name);
    const fullMessage = [text, elementContext].filter(Boolean).join("\n");
    const messageId = ++logIdCounter;

    setInput("");
    setPickedElements([]);
    setAttachments([]);
    setLogs((prev) => [
      ...prev,
      {
        id: messageId,
        type: "user",
        content:
          text +
          (attachmentNames.length
            ? `\n[附件: ${attachmentNames.join(", ")}]`
            : ""),
        timestamp: Date.now(),
        attachmentNames: attachmentNames.length ? attachmentNames : undefined,
        targetTab: targetStatus?.target ?? undefined,
        pickedElements:
          pickedElements.length > 0 ? [...pickedElements] : undefined,
      },
    ]);

    const settings = await sendMessage<{
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      showClickMarker?: boolean;
      provider?: string;
      enableShortRefs?: boolean;
      screenshotScaleMode?: string;
      screenshotMaxLongEdge?: number;
      screenshotMaxPixels?: number;
      enableScreenshotPruning?: boolean;
      screenshotKeepN?: number;
      screenshotPruneTrigger?: number;
      enableCodeExecution?: boolean;
      codeExecutionTimeoutMs?: number;
      codeExecutionMaxOutputChars?: number;
      enablePromptCaching?: boolean;
    }>("settings:get");

    if (!settings?.apiKey) {
      setLogs((prev) => [
        ...prev,
        {
          id: ++logIdCounter,
          type: "error",
          content: "请先在设置页面配置 API Key",
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    setRunning(true);
    try {
      await sendMessage("agent:start", {
        messageId,
        userMessage: fullMessage,
        config: {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || "https://api.openai.com/v1",
          model: settings.model || "gpt-4o",
          permissionMode: autoMode ? "auto" : "ask",
          showClickMarker: settings.showClickMarker !== false,
          provider: settings.provider === "anthropic" ? "anthropic" : "openai",
          enableShortRefs: settings.enableShortRefs !== false,
          screenshotScaleMode: ([
            "off",
            "claude46",
            "claude47",
            "custom",
          ].includes(settings.screenshotScaleMode ?? "")
            ? settings.screenshotScaleMode
            : "claude46") as "off" | "claude46" | "claude47" | "custom",
          screenshotMaxLongEdge:
            typeof settings.screenshotMaxLongEdge === "number"
              ? settings.screenshotMaxLongEdge
              : 1568,
          screenshotMaxPixels:
            typeof settings.screenshotMaxPixels === "number"
              ? settings.screenshotMaxPixels
              : 1150000,
          enableScreenshotPruning: settings.enableScreenshotPruning !== false,
          screenshotKeepN:
            typeof settings.screenshotKeepN === "number"
              ? settings.screenshotKeepN
              : 3,
          screenshotPruneTrigger:
            typeof settings.screenshotPruneTrigger === "number"
              ? settings.screenshotPruneTrigger
              : 12,
          enableCodeExecution: settings.enableCodeExecution !== false,
          codeExecutionTimeoutMs:
            typeof settings.codeExecutionTimeoutMs === "number"
              ? settings.codeExecutionTimeoutMs
              : 1000,
          codeExecutionMaxOutputChars:
            typeof settings.codeExecutionMaxOutputChars === "number"
              ? settings.codeExecutionMaxOutputChars
              : 6000,
          enablePromptCaching: settings.enablePromptCaching === true,
        },
      });
    } catch (err) {
      setLogs((prev) => [
        ...prev,
        {
          id: ++logIdCounter,
          type: "error",
          content: String(err),
          timestamp: Date.now(),
        },
      ]);
      setRunning(false);
    }
  }, [
    input,
    editingMessage,
    running,
    autoMode,
    pickedElements,
    attachments,
    switchingTab,
    targetStatus?.busy,
    targetStatus?.target,
    targetStatusError?.needsReload,
    picking,
  ]);

  const handleStop = useCallback(async () => {
    setLogs((prev) => finishThinking(prev));
    await sendMessage("agent:stop");
    setRunning(false);
  }, []);

  const handleClearChat = useCallback(async () => {
    try {
      await sendMessage("agent:reset");
    } catch (error) {
      setTargetError(getErrorMessage(error));
      return;
    }
    setLogs([]);
    setEditingMessage(null);
    setPromptTokens(null);
    setCacheInfo(null);
    setPickedElements([]);
    setTargetError(null);
    chrome.storage.local.remove(["chatLogs", "chatMeta"]);
    await refreshTargetStatus();
  }, [refreshTargetStatus]);

  const handleApprove = useCallback((toolCallId: string) => {
    sendMessage("agent:approve");
    setLogs((prev) =>
      prev.map((log) =>
        log.toolCallId === toolCallId
          ? { ...log, permissionResolved: true }
          : log,
      ),
    );
  }, []);

  const handleReject = useCallback((toolCallId: string) => {
    sendMessage("agent:reject");
    setLogs((prev) =>
      prev.map((log) =>
        log.toolCallId === toolCallId
          ? { ...log, permissionResolved: true }
          : log,
      ),
    );
  }, []);

  const handlePickElement = useCallback(async () => {
    if (picking) return;
    setPicking(true);
    try {
      const result = await sendMessage<{
        element: Record<string, unknown> | null;
        timeout?: boolean;
      }>("pick:start");
      if (result.element) {
        const el = result.element;
        const rect = el.rect as
          { x: number; y: number; w: number; h: number } | undefined;
        setPickedElements((prev) => [
          ...prev,
          {
            id: ++logIdCounter,
            tag: String(el.tag),
            selector: String(el.selector),
            text: String(el.text || "").slice(0, elementTextLimit),
            rect: rect ?? { x: 0, y: 0, w: 0, h: 0 },
          },
        ]);
      } else if (result.timeout) {
        setLogs((prev) => [
          ...prev,
          {
            id: ++logIdCounter,
            type: "error",
            content: "选择元素超时",
            timestamp: Date.now(),
          },
        ]);
      }
    } catch (err) {
      setLogs((prev) => [
        ...prev,
        {
          id: ++logIdCounter,
          type: "error",
          content: "选择元素失败: " + String(err),
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setPicking(false);
    }
  }, [picking, elementTextLimit]);

  const handleCancelPick = useCallback(() => {
    sendMessage("pick:cancel").catch(() => {});
  }, []);

  const handleDismissLog = useCallback((logId: number) => {
    setLogs((prev) => prev.filter((l) => l.id !== logId));
  }, []);

  const handleCopyText = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  const handleEditMessage = useCallback(
    (entryId: number) => {
      if (running) return;
      const entry = logs.find((l) => l.id === entryId);
      if (!entry || entry.type !== "user") return;
      const text = entry.content.replace(/\n\[附件:.*?\]$/s, "");
      setEditingMessage({ id: entryId, text });
    },
    [logs, running],
  );

  const handleRetry = useCallback(
    async (entryId: number, isUser: boolean, editedText?: string) => {
      if (
        running ||
        switchingTab ||
        targetStatus?.busy ||
        targetStatusError?.needsReload ||
        picking ||
        (editingMessage !== null && editedText === undefined)
      )
        return;
      const idx = logs.findIndex((l) => l.id === entryId);
      if (idx < 0) return;
      // 定位目标 user entry 及其在 user 序列中的索引
      let userIdx = -1;
      let userEntry: LogEntry | undefined;
      if (isUser) {
        userIdx = idx;
        userEntry = logs[idx];
      } else {
        for (let i = idx - 1; i >= 0; i--) {
          if (logs[i].type === "user") {
            userIdx = i;
            userEntry = logs[i];
            break;
          }
        }
      }
      if (!userEntry || userIdx < 0) return;
      const text =
        editedText === undefined
          ? userEntry.content.replace(/\n\[附件:.*?\]$/s, "")
          : editedText.trim();
      if (
        editedText !== undefined &&
        !text &&
        !userEntry.pickedElements?.length
      )
        return;
      setRunning(true);
      try {
        // 计算这是第几个 user 消息（用于 background 侧的对话历史回滚）
        let turnIndex = 0;
        for (let i = 0; i < userIdx; i++) {
          if (logs[i].type === "user") turnIndex++;
        }
        const elementContext =
          userEntry.pickedElements
            ?.map(
              (el) =>
                `[元素: <${el.tag}> selector="${el.selector}" text="${el.text}" rect=(${el.rect.x},${el.rect.y},${el.rect.w}x${el.rect.h}) center=(${Math.round(el.rect.x + el.rect.w / 2)},${Math.round(el.rect.y + el.rect.h / 2)})]`,
            )
            .join("\n") ?? "";
        const fullMessage = [text, elementContext].filter(Boolean).join("\n");
        const settings = await sendMessage<{
          apiKey?: string;
          baseUrl?: string;
          model?: string;
          showClickMarker?: boolean;
          provider?: string;
          enableShortRefs?: boolean;
          screenshotScaleMode?: string;
          screenshotMaxLongEdge?: number;
          screenshotMaxPixels?: number;
          enableScreenshotPruning?: boolean;
          screenshotKeepN?: number;
          screenshotPruneTrigger?: number;
          enableCodeExecution?: boolean;
          codeExecutionTimeoutMs?: number;
          codeExecutionMaxOutputChars?: number;
          enablePromptCaching?: boolean;
        }>("settings:get");
        if (!settings?.apiKey) {
          setLogs((prev) => [
            ...prev,
            {
              id: ++logIdCounter,
              type: "error" as const,
              content: "请先配置 API Key",
              timestamp: Date.now(),
            },
          ]);
          setRunning(false);
          return;
        }
        // 确认提交后才回滚历史，编辑草稿和取消操作不影响对话。
        await sendMessage("agent:truncateBeforeUserTurn", { turnIndex });
        // 重新追加用户消息到 logs（保持原始内容/附件信息便于再次重试）
        const replayedEntry: LogEntry = {
          ...userEntry,
          content:
            editedText === undefined
              ? userEntry.content
              : text + (userEntry.content.match(/\n\[附件:.*?\]$/s)?.[0] ?? ""),
          id: ++logIdCounter,
          timestamp: Date.now(),
          targetTab: targetStatus?.target ?? undefined,
        };
        setLogs([...logs.slice(0, userIdx), replayedEntry]);
        setEditingMessage(null);
        await sendMessage("agent:start", {
          messageId: replayedEntry.id,
          userMessage: fullMessage,
          config: {
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl || "https://api.openai.com/v1",
            model: settings.model || "gpt-4o",
            permissionMode: autoMode ? "auto" : "ask",
            showClickMarker: settings.showClickMarker !== false,
            provider:
              settings.provider === "anthropic" ? "anthropic" : "openai",
            enableShortRefs: settings.enableShortRefs !== false,
            screenshotScaleMode: ([
              "off",
              "claude46",
              "claude47",
              "custom",
            ].includes(settings.screenshotScaleMode ?? "")
              ? settings.screenshotScaleMode
              : "claude46") as "off" | "claude46" | "claude47" | "custom",
            screenshotMaxLongEdge:
              typeof settings.screenshotMaxLongEdge === "number"
                ? settings.screenshotMaxLongEdge
                : 1568,
            screenshotMaxPixels:
              typeof settings.screenshotMaxPixels === "number"
                ? settings.screenshotMaxPixels
                : 1150000,
            enableScreenshotPruning: settings.enableScreenshotPruning !== false,
            screenshotKeepN:
              typeof settings.screenshotKeepN === "number"
                ? settings.screenshotKeepN
                : 3,
            screenshotPruneTrigger:
              typeof settings.screenshotPruneTrigger === "number"
                ? settings.screenshotPruneTrigger
                : 12,
            enableCodeExecution: settings.enableCodeExecution !== false,
            codeExecutionTimeoutMs:
              typeof settings.codeExecutionTimeoutMs === "number"
                ? settings.codeExecutionTimeoutMs
                : 1000,
            codeExecutionMaxOutputChars:
              typeof settings.codeExecutionMaxOutputChars === "number"
                ? settings.codeExecutionMaxOutputChars
                : 6000,
            enablePromptCaching: settings.enablePromptCaching === true,
          },
        });
      } catch (err) {
        setLogs((prev) => [
          ...prev,
          {
            id: ++logIdCounter,
            type: "error" as const,
            content: String(err),
            timestamp: Date.now(),
          },
        ]);
        setRunning(false);
      }
    },
    [
      logs,
      running,
      autoMode,
      targetStatus?.target,
      targetStatus?.busy,
      switchingTab,
      targetStatusError?.needsReload,
      picking,
      editingMessage,
    ],
  );

  const handleAddFiles = useCallback((files: File[]) => {
    const newAttachments: Attachment[] = files.map((file) => ({
      id: ++logIdCounter,
      name: file.name,
      type: file.type,
      size: file.size,
      file,
    }));
    setAttachments((previous) => [...previous, ...newAttachments]);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      handleAddFiles(Array.from(files));
      e.target.value = "";
    },
    [handleAddFiles],
  );

  const segments = useMemo(() => groupLogs(logs), [logs]);
  const turns = useMemo(() => groupIntoTurns(segments), [segments]);
  const targetChipIds = useMemo(() => {
    const ids = new Set<number>();
    let previousUser: LogEntry | undefined;
    for (const entry of logs) {
      if (entry.type !== "user") continue;
      const showChip =
        entry.showTargetTabChip ??
        (!previousUser || previousUser.targetTab?.id !== entry.targetTab?.id);
      if (showChip && entry.targetTab) ids.add(entry.id);
      previousUser = entry;
    }
    return ids;
  }, [logs]);
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<number>>(
    new Set(),
  );
  // 用户手动操作过（展开或折叠）的 key — 自动展开/折叠逻辑对这些 key 不再生效
  const [interactedKeys, setInteractedKeys] = useState<Set<number>>(new Set());

  // 自动展开/折叠 steps 分组（仅对用户未碰过的 key 生效）
  useEffect(() => {
    if (segments.length === 0) return;
    const last = segments[segments.length - 1];
    if (
      last.kind === "steps" &&
      ["tool_call", "thinking"].includes(
        last.entries[last.entries.length - 1].type,
      )
    ) {
      const groupKey = last.entries[0].id;
      if (!interactedKeys.has(groupKey)) {
        setExpandedGroupKeys((prev) =>
          prev.has(groupKey) ? prev : new Set([...prev, groupKey]),
        );
      }
    } else if (last.kind === "assistant") {
      // 助手开始正式回复：折叠所有未被用户碰过的 steps
      setExpandedGroupKeys((prev) => {
        const next = new Set<number>();
        for (const k of prev) {
          if (interactedKeys.has(k)) next.add(k);
        }
        return next;
      });
    }
  }, [segments, interactedKeys]);

  const toggleGroup = useCallback((key: number) => {
    setInteractedKeys((prev) =>
      prev.has(key) ? prev : new Set([...prev, key]),
    );
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <div className="flex h-dvh min-w-0 flex-col">
      <div
        ref={logsScroll.scrollRef}
        onScroll={logsScroll.onScroll}
        onWheelCapture={logsScroll.onWheelCapture}
        onPointerDownCapture={logsScroll.onPointerDownCapture}
        onKeyDownCapture={logsScroll.onKeyDownCapture}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable]"
      >
        {turns.length === 0 && (
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <Bot className="size-10 text-primary/60" />
            <p className="font-medium text-foreground">
              有什么需要我帮你操作的？
            </p>
            <p className="max-w-64 text-xs leading-relaxed">
              输入任务，或选择网页元素作为上下文。
              <br />
              询问模式下，操作执行前会等待你的批准。
            </p>
          </div>
        )}
        {turns.map((turn) => {
          if (turn.kind === "user") {
            const entry = turn.segment.entry;
            const attachmentSuffix = entry.content.match(/\n\[附件: (.*?)\]$/s);
            const attachmentNames =
              entry.attachmentNames ?? attachmentSuffix?.[1].split(", ") ?? [];
            const messageText = attachmentSuffix
              ? entry.content.slice(0, attachmentSuffix.index)
              : entry.content;
            const isEditing = editingMessage?.id === entry.id;
            return (
              <Message from="user" key={entry.id} className="mb-5 max-w-full">
                {isEditing ? (
                  <MessageContent className="w-full border">
                    <Textarea
                      autoFocus
                      aria-label="编辑消息内容"
                      value={editingMessage.text}
                      disabled={running}
                      className="max-h-64 min-h-20 resize-none bg-white text-sm text-zinc-900 dark:bg-input/30 dark:text-foreground"
                      onChange={(event) =>
                        setEditingMessage({
                          id: entry.id,
                          text: event.target.value,
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing || running) return;
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingMessage(null);
                        } else if (
                          event.key === "Enter" &&
                          (event.ctrlKey || event.metaKey)
                        ) {
                          event.preventDefault();
                          void handleRetry(entry.id, true, editingMessage.text);
                        }
                      }}
                    />
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={running}
                        onClick={() => setEditingMessage(null)}
                      >
                        取消
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          running ||
                          switchingTab ||
                          picking ||
                          targetStatus?.busy ||
                          targetStatusError?.needsReload ||
                          (!editingMessage.text.trim() &&
                            !entry.pickedElements?.length)
                        }
                        onClick={() =>
                          void handleRetry(entry.id, true, editingMessage.text)
                        }
                      >
                        保存并重新发送
                      </Button>
                    </div>
                  </MessageContent>
                ) : (
                  messageText && (
                    <MessageContent className="w-full border">
                      <p className="whitespace-pre-wrap break-words">
                        {messageText}
                      </p>
                    </MessageContent>
                  )
                )}
                {entry.targetTab && targetChipIds.has(entry.id) && (
                  <div
                    data-slot="message-target-tab"
                    className="flex max-w-full self-end"
                  >
                    <ReferenceChip
                      label={entry.targetTab.title}
                      icon={<TabIcon tab={entry.targetTab} />}
                    />
                  </div>
                )}
                {!!entry.pickedElements?.length && (
                  <div
                    data-slot="message-picked-elements"
                    className="flex max-w-full flex-wrap justify-end gap-1 self-end"
                  >
                    {entry.pickedElements.map((element) => (
                      <ReferenceChip
                        key={element.id}
                        label={`<${element.tag}> ${element.text || element.selector}`}
                      />
                    ))}
                  </div>
                )}
                {!!attachmentNames.length && (
                  <div
                    data-slot="message-attachments"
                    className="flex max-w-full flex-wrap justify-end gap-1 self-end"
                  >
                    {attachmentNames.map((name, index) => (
                      <ReferenceChip
                        key={index}
                        label={name}
                        icon={<Paperclip className="size-3 shrink-0" />}
                      />
                    ))}
                  </div>
                )}
                {!isEditing && (
                  <MessageActions className="self-end">
                    <MessageAction
                      tooltip="复制"
                      onClick={() => handleCopyText(entry.content)}
                    >
                      <Copy />
                    </MessageAction>
                    <MessageAction
                      tooltip="编辑"
                      disabled={running}
                      onClick={() => handleEditMessage(entry.id)}
                    >
                      <Pencil />
                    </MessageAction>
                    <MessageAction
                      tooltip="重试"
                      disabled={running || editingMessage !== null}
                      onClick={() => handleRetry(entry.id, true)}
                    >
                      <RotateCcw />
                    </MessageAction>
                  </MessageActions>
                )}
              </Message>
            );
          }
          const isLast = turn === turns[turns.length - 1];
          const isComplete = !isLast || !running;
          const allText = turn.segments
            .map((segment) => {
              if (segment.kind === "assistant") return segment.entry.content;
              if (segment.kind === "steps")
                return segment.entries
                  .filter((entry) => entry.type === "tool_call")
                  .map(
                    (entry) =>
                      `${getToolLabel(entry.toolName)}: ${entry.toolResult ?? "..."}`,
                  )
                  .join("\n");
              return "";
            })
            .filter(Boolean)
            .join("\n\n");
          return (
            <Message
              from="assistant"
              key={turn.firstId}
              className="mb-6 max-w-full"
            >
              <MessageContent className="w-full">
                {turn.segments.map((segment, index) => {
                  if (segment.kind === "assistant")
                    return (
                      <MarkdownMessage
                        key={segment.entry.id}
                        content={segment.entry.content}
                        streaming={!isComplete}
                      />
                    );
                  if (segment.kind !== "steps") return null;
                  const groupKey = segment.entries[0].id;
                  const lastEntry = segment.entries[segment.entries.length - 1];
                  const showPending =
                    isLast &&
                    running &&
                    index === turn.segments.length - 1 &&
                    ((lastEntry.type === "tool_call" &&
                      lastEntry.toolResult !== undefined) ||
                      (lastEntry.type === "thinking" &&
                        lastEntry.thinkingDone === true));
                  return (
                    <StepsGroup
                      key={groupKey}
                      entries={segment.entries}
                      expanded={expandedGroupKeys.has(groupKey)}
                      onToggle={() => toggleGroup(groupKey)}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onDismiss={handleDismissLog}
                      pending={showPending}
                    />
                  );
                })}
              </MessageContent>
              {isComplete && (
                <MessageActions>
                  <MessageAction
                    tooltip="复制"
                    onClick={() => handleCopyText(allText)}
                  >
                    <Copy />
                  </MessageAction>
                  <MessageAction
                    tooltip="重试"
                    disabled={running || editingMessage !== null}
                    onClick={() => handleRetry(turn.firstId, false)}
                  >
                    <RotateCcw />
                  </MessageAction>
                </MessageActions>
              )}
            </Message>
          );
        })}
        {running &&
          (segments.length === 0 ||
            segments[segments.length - 1].kind === "user") && (
            <WorkingIndicator />
          )}
        <div ref={logsEndRef} />
      </div>
      <footer className="shrink-0 space-y-2 px-3 pb-3">
        <PromptInput
          onSubmit={() => handleSend()}
          onFilesAdded={handleAddFiles}
          className="rounded-xl bg-card"
          accept="image/*,.pdf,.txt,.json,.csv"
          multiple
        >
          {(picking || pickedElements.length > 0 || attachments.length > 0) && (
            <div className="flex w-full flex-wrap justify-start gap-1 px-3 pt-3">
              {picking && (
                <ReferenceChip
                  label={
                    pickHover
                      ? `当前选择：<${pickHover.tag}> ${pickHover.text.slice(0, 30)}`
                      : "正在选择元素…"
                  }
                  onRemove={handleCancelPick}
                  className="border-amber-500/50 text-amber-600 dark:text-amber-300"
                />
              )}
              {pickedElements.map((element) => (
                <ReferenceChip
                  key={element.id}
                  label={`<${element.tag}> ${element.text || element.selector}`}
                  onRemove={() =>
                    setPickedElements((previous) =>
                      previous.filter((item) => item.id !== element.id),
                    )
                  }
                />
              ))}
              {attachments.map((attachment) => (
                <ReferenceChip
                  key={attachment.id}
                  label={attachment.name}
                  icon={<Paperclip className="size-3 shrink-0" />}
                  onRemove={() =>
                    setAttachments((previous) =>
                      previous.filter((item) => item.id !== attachment.id),
                    )
                  }
                />
              ))}
            </div>
          )}
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={running}
              placeholder="给 NekoPilot 下达任务…"
              aria-label="任务内容"
              className="max-h-32 min-h-20"
            />
          </PromptInputBody>
          <PromptInputFooter className="flex-wrap gap-y-2">
            <PromptInputTools>
              <IconAction
                label="新建对话"
                onClick={handleClearChat}
                disabled={
                  running || targetStatus?.busy || switchingTab || picking
                }
              >
                <MessageSquarePlus />
              </IconAction>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <PromptInputButton
                        aria-label={autoMode ? "自动模式" : "询问模式"}
                      >
                        {autoMode ? <FastForward /> : <Hand />}
                      </PromptInputButton>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>切换审批模式</TooltipContent>
                </Tooltip>
                <DropdownMenuContent side="top" align="start">
                  <DropdownMenuRadioGroup
                    value={autoMode ? "auto" : "ask"}
                    onValueChange={(value) =>
                      setAutoModeAndPersist(value === "auto")
                    }
                  >
                    <DropdownMenuRadioItem
                      value="auto"
                      className="cursor-pointer"
                    >
                      <FastForward className="size-4" />
                      自动执行
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem
                      value="ask"
                      className="cursor-pointer"
                    >
                      <Hand className="size-4" />
                      需要审批
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </PromptInputTools>
            <PromptInputTools className="ml-auto">
              {promptTokens !== null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="cursor-default px-1 font-mono text-xs text-muted-foreground"
                      aria-label="上下文 Token 用量"
                    >
                      {formatTokens(
                        promptTokens +
                          (cacheInfo ? cacheInfo.creation + cacheInfo.read : 0),
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div>上下文: {promptTokens.toLocaleString()}</div>
                    {cacheInfo && (
                      <>
                        <div>
                          缓存写入: {cacheInfo.creation.toLocaleString()}
                        </div>
                        <div>缓存命中: {cacheInfo.read.toLocaleString()}</div>
                      </>
                    )}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="inline-flex"
                    tabIndex={targetMismatch ? 0 : undefined}
                  >
                    <PromptInputButton
                      aria-label="选择页面元素"
                      onClick={handlePickElement}
                      disabled={
                        !targetStatus?.target ||
                        targetMismatch ||
                        picking ||
                        running ||
                        targetStatus?.busy ||
                        switchingTab
                      }
                    >
                      <MousePointer2
                        className={cn(picking && "text-primary")}
                      />
                    </PromptInputButton>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="whitespace-pre-line">
                  {targetMismatch
                    ? `选择页面元素\n请先切换到“${truncatedTargetTitle}”`
                    : "选择页面元素"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PromptInputButton
                    aria-label="添加附件"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip />
                  </PromptInputButton>
                </TooltipTrigger>
                <TooltipContent>添加附件</TooltipContent>
              </Tooltip>
              <PromptInputSubmit
                type={running ? "button" : "submit"}
                status={running ? "streaming" : "ready"}
                aria-label={running ? "停止" : "发送消息"}
                disabled={
                  !running &&
                  (picking ||
                    editingMessage !== null ||
                    switchingTab ||
                    targetStatusError?.needsReload ||
                    targetStatus?.busy ||
                    (!input.trim() && pickedElements.length === 0))
                }
                onClick={running ? handleStop : undefined}
              />
            </PromptInputTools>
          </PromptInputFooter>
        </PromptInput>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <TabSelector
            status={targetStatus}
            running={running}
            picking={picking}
            switching={switchingTab}
            onRefresh={refreshTargetStatus}
            onSelect={handleSwitchTab}
          />
          <IconAction
            label="设置"
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            <Settings />
          </IconAction>
        </div>
        {targetError && (
          <p role="alert" className="break-words text-xs text-destructive">
            {targetError}
          </p>
        )}
        {targetStatusError && (
          <div
            role="alert"
            className="flex min-w-0 items-center gap-2 text-xs text-destructive"
          >
            <p className="min-w-0 flex-1 break-words">
              {targetStatusError.message}
            </p>
            {targetStatusError.needsReload ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs"
                disabled={running || picking}
                onClick={() => chrome.runtime.reload()}
              >
                重新加载扩展
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={() => void refreshTargetStatus(true)}
              >
                重试
              </Button>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          hidden
          accept="image/*,.pdf,.txt,.json,.csv"
          multiple
          onChange={handleFileChange}
        />
      </footer>
    </div>
  );
}
