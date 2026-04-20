import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Box,
  IconButton,
  Typography,
  Paper,
  Chip,
  Stack,
  Tooltip,
  CircularProgress,
  AppBar,
  Toolbar,
  InputBase,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Collapse,
  Button,
} from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import StopIcon from "@mui/icons-material/Stop";
import CloseIcon from "@mui/icons-material/Close";
import SettingsIcon from "@mui/icons-material/Settings";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import NearMeIcon from "@mui/icons-material/NearMe";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import AddCommentIcon from "@mui/icons-material/AddComment";
import DoubleArrowIcon from "@mui/icons-material/DoubleArrow";
import PanToolAltIcon from "@mui/icons-material/PanToolAlt";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import CameraAltOutlinedIcon from "@mui/icons-material/CameraAltOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import TouchAppOutlinedIcon from "@mui/icons-material/TouchAppOutlined";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import PsychologyAltOutlinedIcon from "@mui/icons-material/PsychologyAltOutlined";
import EditIcon from "@mui/icons-material/Edit";
import ReplayIcon from "@mui/icons-material/Replay";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sendMessage } from "../shared/messaging";
import type { AgentEvent } from "../agent/types";

// ── 类型定义 ──

interface PickedElement {
  id: number;
  tag: string;
  selector: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
}

interface Attachment {
  id: number;
  name: string;
  type: string;
  size: number;
  file: File;
}

interface LogEntry {
  id: number;
  type: "user" | "assistant" | "thinking" | "tool_call" | "error";
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolResult?: string;
  toolSuccess?: boolean;
  needsPermission?: boolean;
  permissionResolved?: boolean;
  screenshotData?: string;
  pickedElements?: PickedElement[];
  // thinking 相关
  thinkingDone?: boolean;
  thinkSeconds?: number;
}

let logIdCounter = 0;

/** 将含 <think>...</think> 或 <thinking>...</thinking> 的原始内容拆为思考与正文。
 *  仅当存在闭合标签时才会拆出 body；否则全部视为思考中。 */
function splitThinkText(raw: string): { think: string; body: string } {
  if (!raw) return { think: "", body: "" };
  const closeMatch = raw.match(/<\/think(?:ing)?>/i);
  if (!closeMatch) {
    // 还在思考中：剥掉可能的开头 <think> 前缀
    return { think: raw.replace(/^\s*<think(?:ing)?>/i, ""), body: "" };
  }
  const closeIdx = closeMatch.index!;
  const closeLen = closeMatch[0].length;
  const before = raw.slice(0, closeIdx);
  const after = raw.slice(closeIdx + closeLen);
  const think = before.replace(/^\s*<think(?:ing)?>/i, "").trim();
  return { think, body: after.trim() };
}

// ── 工具图标与标签 ──

function getToolIcon(name?: string) {
  switch (name) {
    case "screenshot":
      return <CameraAltOutlinedIcon sx={{ fontSize: 16 }} />;
    case "read_page_text":
    case "read_page":
    case "read_page_interactive":
    case "find_element":
    case "get_element_text":
    case "get_element_rect":
      return <VisibilityOutlinedIcon sx={{ fontSize: 16 }} />;
    case "click":
    case "set_input":
    case "drag":
    case "scroll":
      return <TouchAppOutlinedIcon sx={{ fontSize: 16 }} />;
    default:
      return <BuildOutlinedIcon sx={{ fontSize: 16 }} />;
  }
}

function getToolLabel(name?: string): string {
  const labels: Record<string, string> = {
    screenshot: "Take screenshot",
    read_page_text: "Extract page text",
    read_page: "Read page structure",
    read_page_interactive: "Find interactive elements",
    click: "Click",
    set_input: "Type text",
    scroll: "Scroll page",
    navigate: "Navigate",
    wait: "Wait",
    find_element: "Find element",
    get_element_text: "Get element text",
    get_element_rect: "Get element position",
    drag: "Drag",
  };
  return labels[name ?? ""] ?? name ?? "Tool";
}

// ── 日志分段 ──

type LogSegment =
  | { kind: "user"; entry: LogEntry }
  | { kind: "assistant"; entry: LogEntry }
  | { kind: "steps"; entries: LogEntry[] };

type Turn =
  | { kind: "user"; segment: LogSegment & { kind: "user" } }
  | { kind: "model"; segments: LogSegment[]; firstId: number };

function groupLogs(logs: LogEntry[]): LogSegment[] {
  const segments: LogSegment[] = [];
  let currentSteps: LogEntry[] = [];
  const flushSteps = () => {
    if (currentSteps.length > 0) {
      segments.push({ kind: "steps", entries: [...currentSteps] });
      currentSteps = [];
    }
  };
  for (const entry of logs) {
    if (entry.type === "user" || entry.type === "assistant") {
      flushSteps();
      segments.push({ kind: entry.type, entry });
    } else {
      // thinking / tool_call / error 都归入 steps
      currentSteps.push(entry);
    }
  }
  flushSteps();
  return segments;
}

function groupIntoTurns(segments: LogSegment[]): Turn[] {
  const turns: Turn[] = [];
  let modelSegs: LogSegment[] = [];
  let modelFirstId = 0;
  const flushModel = () => {
    if (modelSegs.length > 0) {
      turns.push({ kind: "model", segments: [...modelSegs], firstId: modelFirstId });
      modelSegs = [];
    }
  };
  for (const seg of segments) {
    if (seg.kind === "user") {
      flushModel();
      turns.push({ kind: "user", segment: seg });
    } else {
      if (modelSegs.length === 0) {
        modelFirstId = seg.kind === "steps" ? seg.entries[0].id : seg.entry.id;
      }
      modelSegs.push(seg);
    }
  }
  flushModel();
  return turns;
}

const markdownSx = {
  wordBreak: "break-word",
  lineHeight: 1.6,
  fontSize: "0.875rem",
  "& p": { m: 0, mb: 1, "&:last-child": { mb: 0 } },
  "& ul, & ol": { my: 0.5, pl: 2.5 },
  "& li": { mb: 0.25 },
  "& pre": {
    bgcolor: "background.default",
    borderRadius: 1,
    p: 1.5,
    overflow: "auto",
    fontSize: "0.78rem",
    my: 1,
  },
  "& code": { fontFamily: "monospace", fontSize: "0.82em" },
  "& :not(pre) > code": { bgcolor: "action.selected", borderRadius: 0.5, px: 0.5, py: 0.15 },
  "& blockquote": { borderLeft: 3, borderColor: "divider", pl: 1.5, ml: 0, my: 1, opacity: 0.8 },
  "& table": { borderCollapse: "collapse", width: "100%", my: 1, fontSize: "0.8rem" },
  "& th, & td": { border: 1, borderColor: "divider", px: 1, py: 0.5, textAlign: "left" },
  "& th": { bgcolor: "action.hover", fontWeight: 600 },
  "& h1, & h2, & h3, & h4": { mt: 1.5, mb: 0.5, fontSize: "0.95rem", fontWeight: 600 },
  "& a": { color: "primary.main" },
  "& hr": { borderColor: "divider", my: 1.5 },
  "& img": { maxWidth: "100%", borderRadius: 1 },
};

// ── 主组件 ──

export default function App() {
  const [input, setInput] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [attached, setAttached] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [modeMenuAnchor, setModeMenuAnchor] = useState<null | HTMLElement>(null);
  const [picking, setPicking] = useState(false);
  const [pickHover, setPickHover] = useState<{ tag: string; text: string } | null>(null);
  const [pickedElements, setPickedElements] = useState<PickedElement[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [elementTextLimit, setElementTextLimit] = useState(128);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 加载持久化设置
  useEffect(() => {
    chrome.storage.local.get(["autoMode", "settings"], (data) => {
      if (data.autoMode !== undefined) setAutoMode(data.autoMode);
      if (data.settings?.elementTextLimit != null) setElementTextLimit(data.settings.elementTextLimit);
    });
  }, []);

  // 轮询元素选择器 hover 信息
  useEffect(() => {
    if (!picking) { setPickHover(null); return; }
    const timer = setInterval(async () => {
      try {
        const res = await sendMessage<{ hover: { tag: string; text: string } | null }>("pick:hover");
        setPickHover(res.hover);
      } catch { setPickHover(null); }
    }, 300);
    return () => clearInterval(timer);
  }, [picking]);

  // 监听 agent 事件
  useEffect(() => {
    const listener = (message: { type: string; payload?: AgentEvent }) => {
      if (message.type !== "agent:event" || !message.payload) return;
      const event = message.payload;

      if (event.type === "done") {
        setRunning(false);
        return;
      }

      if (event.type === "message") {
        setLogs((prev) => [...prev, {
          id: ++logIdCounter,
          type: "assistant",
          content: typeof event.data === "string" ? event.data : JSON.stringify(event.data),
          timestamp: Date.now(),
        }]);
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
          if (lastThink !== -1 && lastThink > lastAsst && !prev[lastThink].thinkingDone) {
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
              thinkSeconds: Math.max(1, Math.round((Date.now() - old.timestamp) / 1000)),
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
              thinkSeconds: Math.max(1, Math.round((now - old.timestamp) / 1000)),
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
        const data = event.data as { name: string; args: string; id: string; needsPermission?: boolean };
        setLogs((prev) => [...prev, {
          id: ++logIdCounter,
          type: "tool_call",
          content: data.args,
          toolName: data.name,
          toolCallId: data.id,
          needsPermission: data.needsPermission,
          timestamp: Date.now(),
        }]);
        return;
      }

      if (event.type === "tool_result") {
        const data = event.data as { name: string; result: { success: boolean; data?: unknown; error?: string }; id: string };
        setLogs((prev) => prev.map((log) => {
          if (log.type === "tool_call" && log.toolCallId === data.id) {
            const resultData = data.result.data ?? data.result.error;
            // 字符串结果直接保留（避免 JSON.stringify 把 \n 转义为字面量）
            const formatted = resultData === undefined
              ? "done"
              : typeof resultData === "string"
                ? resultData
                : JSON.stringify(resultData, null, 2);
            return {
              ...log,
              toolResult: formatted,
              toolSuccess: data.result.success,
              screenshotData: data.name === "screenshot" && data.result.success ? String(data.result.data) : undefined,
            };
          }
          return log;
        }));
        return;
      }

      if (event.type === "thinking") {
        const text = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
        setLogs((prev) => [...prev, {
          id: ++logIdCounter,
          type: "thinking",
          content: text,
          timestamp: Date.now(),
          thinkingDone: false,
        }]);
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
            thinkSeconds = Math.max(1, Math.round((Date.now() - old.timestamp) / 1000));
          }
          updated[lastIdx] = { ...old, content: nextContent, thinkingDone, thinkSeconds };
          return updated;
        });
        return;
      }

      if (event.type === "error") {
        setLogs((prev) => [...prev, {
          id: ++logIdCounter,
          type: "error",
          content: typeof event.data === "string" ? event.data : JSON.stringify(event.data),
          timestamp: Date.now(),
        }]);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // 自动滚动
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // 检查连接状态
  useEffect(() => {
    sendMessage<{ attached: boolean }>("cdp:status").then((res) =>
      setAttached(res.attached)
    );
  }, []);

  const setAutoModeAndPersist = useCallback((value: boolean) => {
    setAutoMode(value);
    chrome.storage.local.set({ autoMode: value });
    // 实时同步给正在运行的 agent
    sendMessage("agent:setMode", { mode: value ? "auto" : "ask" }).catch(() => {});
  }, []);

  const handleAttach = useCallback(async () => {
    if (attached) {
      await sendMessage("cdp:detach");
      setAttached(false);
    } else {
      await sendMessage("cdp:attach");
      setAttached(true);
    }
  }, [attached]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || running) return;

    const elementContext = pickedElements
      .map((el) => `[元素: <${el.tag}> selector="${el.selector}" text="${el.text}" rect=(${el.rect.x},${el.rect.y},${el.rect.w}x${el.rect.h}) center=(${Math.round(el.rect.x + el.rect.w / 2)},${Math.round(el.rect.y + el.rect.h / 2)})]`)
      .join("\n");
    const attachmentNames = attachments.map((a) => a.name);
    const fullMessage = [text, elementContext].filter(Boolean).join("\n");

    setInput("");
    setPickedElements([]);
    setAttachments([]);
    setLogs((prev) => [
      ...prev,
      {
        id: ++logIdCounter,
        type: "user",
        content: text + (attachmentNames.length ? `\n[附件: ${attachmentNames.join(", ")}]` : ""),
        timestamp: Date.now(),
        pickedElements: pickedElements.length > 0 ? [...pickedElements] : undefined,
      },
    ]);

    const settings = await sendMessage<{
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      showClickMarker?: boolean;
      provider?: string;
    }>("settings:get");

    if (!settings?.apiKey) {
      setLogs((prev) => [
        ...prev,
        { id: ++logIdCounter, type: "error", content: "请先在设置页面配置 API Key", timestamp: Date.now() },
      ]);
      return;
    }

    setRunning(true);
    try {
      await sendMessage("agent:start", {
        userMessage: fullMessage,
        config: {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || "https://api.openai.com/v1",
          model: settings.model || "gpt-4o",
          maxIterations: 20,
          permissionMode: autoMode ? "auto" : "ask",
          showClickMarker: settings.showClickMarker !== false,
          provider: settings.provider === "anthropic" ? "anthropic" : "openai",
        },
      });
    } catch (err) {
      setLogs((prev) => [
        ...prev,
        { id: ++logIdCounter, type: "error", content: String(err), timestamp: Date.now() },
      ]);
      setRunning(false);
    }
  }, [input, running, autoMode, pickedElements, attachments]);

  const handleStop = useCallback(async () => {
    await sendMessage("agent:stop");
    setRunning(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleClearChat = useCallback(() => {
    setLogs([]);
    sendMessage("agent:reset").catch(() => {});
  }, []);

  const handleApprove = useCallback((toolCallId: string) => {
    sendMessage("agent:approve");
    setLogs((prev) => prev.map((log) =>
      log.toolCallId === toolCallId ? { ...log, permissionResolved: true } : log
    ));
  }, []);

  const handleReject = useCallback((toolCallId: string) => {
    sendMessage("agent:reject");
    setLogs((prev) => prev.map((log) =>
      log.toolCallId === toolCallId ? { ...log, permissionResolved: true } : log
    ));
  }, []);

  const handlePickElement = useCallback(async () => {
    if (picking) return;
    setPicking(true);
    try {
      const result = await sendMessage<{ element: Record<string, unknown> | null; timeout?: boolean }>("pick:start");
      if (result.element) {
        const el = result.element;
        const rect = el.rect as { x: number; y: number; w: number; h: number } | undefined;
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
          { id: ++logIdCounter, type: "error", content: "选择元素超时", timestamp: Date.now() },
        ]);
      }
    } catch (err) {
      setLogs((prev) => [
        ...prev,
        { id: ++logIdCounter, type: "error", content: "选择元素失败: " + String(err), timestamp: Date.now() },
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

  const handleEditMessage = useCallback(async (entryId: number) => {
    if (running) return;
    const entry = logs.find((l) => l.id === entryId);
    if (!entry || entry.type !== "user") return;
    const text = entry.content.replace(/\n\[附件:.*?\]$/s, "");
    setInput(text);
    if (entry.pickedElements) setPickedElements([...entry.pickedElements]);
    await sendMessage("agent:reset");
    setLogs((prev) => {
      const idx = prev.findIndex((l) => l.id === entryId);
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
  }, [logs, running]);

  const handleRetry = useCallback(async (entryId: number, isUser: boolean) => {
    if (running) return;
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
        if (logs[i].type === "user") { userIdx = i; userEntry = logs[i]; break; }
      }
    }
    if (!userEntry || userIdx < 0) return;
    // 计算这是第几个 user 消息（用于 background 侧的对话历史回滚）
    let turnIndex = 0;
    for (let i = 0; i < userIdx; i++) {
      if (logs[i].type === "user") turnIndex++;
    }
    // 后端截断到该 user 消息之前（不含），保留先前对话
    await sendMessage("agent:truncateBeforeUserTurn", { turnIndex });
    // 前端 logs 也截断到该 user 消息之前
    setLogs(logs.slice(0, userIdx));
    const text = userEntry.content.replace(/\n\[附件:.*?\]$/s, "");
    const elementContext = userEntry.pickedElements
      ?.map((el) => `[元素: <${el.tag}> selector="${el.selector}" text="${el.text}" rect=(${el.rect.x},${el.rect.y},${el.rect.w}x${el.rect.h}) center=(${Math.round(el.rect.x + el.rect.w / 2)},${Math.round(el.rect.y + el.rect.h / 2)})]`)
      .join("\n") ?? "";
    const fullMessage = [text, elementContext].filter(Boolean).join("\n");
    const settings = await sendMessage<{ apiKey?: string; baseUrl?: string; model?: string; showClickMarker?: boolean; provider?: string }>("settings:get");
    if (!settings?.apiKey) {
      setLogs((prev) => [...prev, { id: ++logIdCounter, type: "error" as const, content: "请先配置 API Key", timestamp: Date.now() }]);
      return;
    }
    // 重新追加用户消息到 logs（保持原始内容/附件信息便于再次重试）
    const replayedEntry: LogEntry = { ...userEntry, id: ++logIdCounter, timestamp: Date.now() };
    setLogs((prev) => [...prev, replayedEntry]);
    setRunning(true);
    try {
      await sendMessage("agent:start", {
        userMessage: fullMessage,
        config: {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || "https://api.openai.com/v1",
          model: settings.model || "gpt-4o",
          maxIterations: 20,
          permissionMode: autoMode ? "auto" : "ask",
          showClickMarker: settings.showClickMarker !== false,
          provider: settings.provider === "anthropic" ? "anthropic" : "openai",
        },
      });
    } catch (err) {
      setLogs((prev) => [...prev, { id: ++logIdCounter, type: "error" as const, content: String(err), timestamp: Date.now() }]);
      setRunning(false);
    }
  }, [logs, running, autoMode]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newAttachments: Attachment[] = Array.from(files).map((f) => ({
      id: ++logIdCounter,
      name: f.name,
      type: f.type,
      size: f.size,
      file: f,
    }));
    setAttachments((prev) => [...prev, ...newAttachments]);
    e.target.value = "";
  }, []);

  const segments = useMemo(() => groupLogs(logs), [logs]);
  const turns = useMemo(() => groupIntoTurns(segments), [segments]);
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<number>>(new Set());

  // 自动展开/折叠 steps 分组
  useEffect(() => {
    if (logs.length === 0) return;
    const last = logs[logs.length - 1];
    if (last.type === "tool_call" || last.type === "thinking") {
      let groupStart = logs.length - 1;
      while (
        groupStart > 0 &&
        (logs[groupStart - 1].type === "tool_call" ||
          logs[groupStart - 1].type === "error" ||
          logs[groupStart - 1].type === "thinking")
      ) {
        groupStart--;
      }
      setExpandedGroupKeys((prev) => new Set([...prev, logs[groupStart].id]));
    } else if (last.type === "assistant") {
      // 助手开始正式回复：折叠所有 steps
      setExpandedGroupKeys(new Set());
    }
  }, [logs]);

  const toggleGroup = useCallback((key: number) => {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* 顶栏 */}
      <AppBar position="static" color="transparent" elevation={0}>
        <Toolbar variant="dense" sx={{ gap: 1 }}>
          <SmartToyIcon color="primary" />
          <Typography variant="subtitle1" sx={{ fontWeight: 700, flexGrow: 1 }}>
            NekoPilot
          </Typography>
          <Tooltip title="新建对话">
            <IconButton size="small" onClick={handleClearChat}>
              <AddCommentIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title={attached ? "断开 CDP" : "连接 CDP"}>
            <IconButton size="small" onClick={handleAttach}>
              {attached ? <LinkIcon color="success" /> : <LinkOffIcon color="disabled" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="设置">
            <IconButton size="small" onClick={() => chrome.runtime.openOptionsPage()}>
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      {/* 对话区 */}
      <Box sx={{ flex: 1, overflow: "auto", px: 1.5, py: 1 }}>
        {turns.map((turn) => {
          if (turn.kind === "user") {
            const seg = turn.segment;
            return (
              <Box key={seg.entry.id} sx={{ mb: 2, mt: 1, "&:hover .hover-actions": { opacity: 1 } }}>
                <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  <Typography variant="body2">{seg.entry.content}</Typography>
                  {seg.entry.pickedElements && seg.entry.pickedElements.length > 0 && (
                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 1 }}>
                      {seg.entry.pickedElements.map((el) => (
                        <Chip
                          key={`uel-${el.id}`}
                          label={`<${el.tag}> ${el.text || el.selector}`}
                          size="small"
                          color="primary"
                          variant="outlined"
                          icon={<NearMeIcon sx={{ fontSize: "14px !important" }} />}
                          sx={{ maxWidth: 240, fontSize: "0.75rem" }}
                        />
                      ))}
                    </Box>
                  )}
                </Paper>
                <Stack direction="row" className="hover-actions" sx={{ opacity: 0, transition: "opacity 0.15s", gap: 0.25, mt: 0.25 }}>
                  <Tooltip title="复制"><IconButton size="small" onClick={() => handleCopyText(seg.entry.content)} sx={{ p: 0.25 }}><ContentCopyIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                  <Tooltip title="编辑"><IconButton size="small" onClick={() => handleEditMessage(seg.entry.id)} disabled={running} sx={{ p: 0.25 }}><EditIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                  <Tooltip title="重试"><IconButton size="small" onClick={() => handleRetry(seg.entry.id, true)} disabled={running} sx={{ p: 0.25 }}><ReplayIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                </Stack>
              </Box>
            );
          }
          // model turn: 多个 segment 组成一个完整回复块
          const isLast = turn === turns[turns.length - 1];
          const isComplete = !isLast || !running;
          // 收集所有文本用于复制
          const allText = turn.segments.map((seg) => {
            if (seg.kind === "assistant") return seg.entry.content;
            if (seg.kind === "steps") return seg.entries.filter((e) => e.type === "tool_call").map((e) => `${getToolLabel(e.toolName)}: ${e.toolResult ?? "..."}`).join("\n");
            return "";
          }).filter(Boolean).join("\n\n");
          return (
            <Box key={turn.firstId} sx={{ mb: 2, "&:hover > .hover-actions": { opacity: 1 } }}>
              {turn.segments.map((seg) => {
                if (seg.kind === "assistant") {
                  return (
                    <Box key={seg.entry.id} sx={{ mb: 1, ...markdownSx }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.entry.content}</ReactMarkdown>
                    </Box>
                  );
                }
                if (seg.kind === "steps") {
                  const groupKey = seg.entries[0].id;
                  return (
                    <StepsGroup
                      key={groupKey}
                      entries={seg.entries}
                      expanded={expandedGroupKeys.has(groupKey)}
                      onToggle={() => toggleGroup(groupKey)}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onDismiss={handleDismissLog}
                    />
                  );
                }
                return null;
              })}
              {isComplete && (
                <Stack direction="row" className="hover-actions" sx={{ opacity: 0, transition: "opacity 0.15s", gap: 0.25 }}>
                  <Tooltip title="复制"><IconButton size="small" onClick={() => handleCopyText(allText)} sx={{ p: 0.25 }}><ContentCopyIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                  <Tooltip title="重试"><IconButton size="small" onClick={() => handleRetry(turn.firstId, false)} disabled={running} sx={{ p: 0.25 }}><ReplayIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                </Stack>
              )}
            </Box>
          );
        })}
        {running && (logs.length === 0 || logs[logs.length - 1].type === "user") && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 1, pl: 0.5 }}>
            <CircularProgress size={14} />
            <Typography variant="body2" sx={{ opacity: 0.5 }}>思考中...</Typography>
          </Box>
        )}
        <div ref={logsEndRef} />
      </Box>

      {/* 底栏 */}
      <Box sx={{ p: 1.5, pt: 0 }}>
        {autoMode && (
          <Paper
            variant="outlined"
            sx={{
              px: 1.5, py: 0.75, mb: 1, borderRadius: 2,
              bgcolor: "warning.dark", borderColor: "warning.main",
            }}
          >
            <Typography variant="caption" sx={{ color: "warning.contrastText" }}>
              ⚠ Auto 模式：NekoPilot 将直接执行所有操作，不会询问确认。
            </Typography>
          </Paper>
        )}

        <Paper variant="outlined" sx={{ borderRadius: 3, overflow: "hidden" }}>
          {/* 附加 Chip */}
          {(picking || pickedElements.length > 0 || attachments.length > 0) && (
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, px: 1.5, pt: 1, pb: 0 }}>
              {picking && (
                <Chip
                  label={pickHover ? `当前选择：<${pickHover.tag}> ${pickHover.text.slice(0, 30) || ""}` : "正在选择元素..."}
                  size="small"
                  color="warning"
                  variant="outlined"
                  icon={<NearMeIcon sx={{ fontSize: "14px !important" }} />}
                  onDelete={handleCancelPick}
                  sx={{ fontSize: "0.75rem", maxWidth: 280 }}
                />
              )}
              {pickedElements.map((el) => (
                <Chip
                  key={`el-${el.id}`}
                  label={`<${el.tag}> ${el.text || el.selector}`}
                  size="small"
                  color="primary"
                  variant="outlined"
                  icon={<NearMeIcon sx={{ fontSize: "14px !important" }} />}
                  onDelete={() => setPickedElements((prev) => prev.filter((e) => e.id !== el.id))}
                  sx={{ maxWidth: 200, fontSize: "0.75rem" }}
                />
              ))}
              {attachments.map((att) => (
                <Chip
                  key={`att-${att.id}`}
                  label={att.name}
                  size="small"
                  color="secondary"
                  variant="outlined"
                  icon={<AttachFileIcon sx={{ fontSize: "14px !important" }} />}
                  onDelete={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                  sx={{ maxWidth: 200, fontSize: "0.75rem" }}
                />
              ))}
            </Box>
          )}

          {/* 输入 */}
          <InputBase
            fullWidth
            multiline
            maxRows={4}
            placeholder="Reply to NekoPilot"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={running}
            sx={{
              px: 2,
              pt: picking || pickedElements.length > 0 || attachments.length > 0 ? 0.5 : 1.5,
              pb: 0.5,
              fontSize: "0.9rem",
            }}
          />

          {/* 工具行 */}
          <Stack direction="row" alignItems="center" sx={{ px: 1, pb: 0.5, pt: 0 }}>
            <Box
              onClick={(e) => setModeMenuAnchor(e.currentTarget)}
              sx={{
                display: "flex", alignItems: "center", gap: 0.5,
                cursor: "pointer", px: 1, py: 0.5, borderRadius: 1,
                "&:hover": { bgcolor: "action.hover" }, userSelect: "none",
              }}
            >
              {autoMode
                ? <DoubleArrowIcon sx={{ fontSize: 16, opacity: 0.7 }} />
                : <PanToolAltIcon sx={{ fontSize: 16, opacity: 0.7 }} />}
              <Typography variant="caption" sx={{ opacity: 0.8 }}>
                {autoMode ? "Auto mode" : "Ask before acting"}
              </Typography>
              <KeyboardArrowDownIcon sx={{ fontSize: 14, opacity: 0.5 }} />
            </Box>

            <Menu
              anchorEl={modeMenuAnchor}
              open={Boolean(modeMenuAnchor)}
              onClose={() => setModeMenuAnchor(null)}
              anchorOrigin={{ vertical: "top", horizontal: "left" }}
              transformOrigin={{ vertical: "bottom", horizontal: "left" }}
              slotProps={{ paper: { sx: { minWidth: 0 } }, list: { dense: true } }}
            >
              <MenuItem
                onClick={() => { setAutoModeAndPersist(true); setModeMenuAnchor(null); }}
                selected={autoMode}
                sx={{ py: 0.5 }}
              >
                <ListItemIcon sx={{ minWidth: 28 }}>
                  <DoubleArrowIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primaryTypographyProps={{ variant: "body2" }}>Auto mode</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => { setAutoModeAndPersist(false); setModeMenuAnchor(null); }}
                selected={!autoMode}
                sx={{ py: 0.5 }}
              >
                <ListItemIcon sx={{ minWidth: 28 }}>
                  <PanToolAltIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primaryTypographyProps={{ variant: "body2" }}>Ask before acting</ListItemText>
              </MenuItem>
            </Menu>

            <Box sx={{ flexGrow: 1 }} />

            <Tooltip title={picking ? "正在选择..." : "选择页面元素"}>
              <IconButton size="small" onClick={handlePickElement} disabled={picking} color={picking ? "primary" : "default"}>
                <NearMeIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="添加附件">
              <IconButton size="small" component="label">
                <AttachFileIcon sx={{ fontSize: 18 }} />
                <input ref={fileInputRef} type="file" hidden accept="image/*,.pdf,.txt,.json,.csv" multiple onChange={handleFileChange} />
              </IconButton>
            </Tooltip>
            {running ? (
              <Tooltip title="停止">
                <IconButton size="small" onClick={handleStop}>
                  <StopIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title="发送消息">
                <IconButton size="small" onClick={handleSend} disabled={!input.trim() && pickedElements.length === 0} color="primary">
                  <SendIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
        </Paper>
      </Box>
    </Box>
  );
}

// ── 步骤时间线组件 ──

// ── Steps 可折叠分组 ──

function StepsGroup({
  entries,
  expanded,
  onToggle,
  onApprove,
  onReject,
  onDismiss,
}: {
  entries: LogEntry[];
  expanded: boolean;
  onToggle: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDismiss: (id: number) => void;
}) {
  const stepCount = entries.filter((e) => e.type === "tool_call" || e.type === "thinking").length;

  // 只有 1 步时直接显示，不包裹
  if (stepCount <= 1) {
    return (
      <Box sx={{ mb: 1 }}>
        {entries.map((entry, i) => (
          <TimelineStep
            key={entry.id}
            entry={entry}
            showTopLine={i > 0}
            showBottomLine={i < entries.length - 1}
            onApprove={onApprove}
            onReject={onReject}
            onDismiss={onDismiss}
          />
        ))}
      </Box>
    );
  }

  return (
    <Box sx={{ mb: 1 }}>
      {/* 可折叠标题 */}
      <Box
        onClick={onToggle}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          cursor: "pointer",
          py: 0.5,
          "&:hover": { opacity: 0.8 },
          userSelect: "none",
        }}
      >
        <Typography variant="body2" sx={{ opacity: 0.5, fontWeight: 500 }}>
          {stepCount} {stepCount === 1 ? "step" : "steps"}
        </Typography>
        <ExpandMoreIcon
          sx={{
            fontSize: 16,
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s",
            opacity: 0.4,
          }}
        />
      </Box>

      {/* 可折叠时间线 */}
      <Collapse in={expanded}>
        {entries.map((entry, i) => (
          <TimelineStep
            key={entry.id}
            entry={entry}
            showTopLine={i > 0}
            showBottomLine={i < entries.length - 1}
            onApprove={onApprove}
            onReject={onReject}
            onDismiss={onDismiss}
          />
        ))}
      </Collapse>
    </Box>
  );
}

// ── 时间线步骤 ──

function TimelineStep({
  entry,
  showTopLine,
  showBottomLine,
  onApprove,
  onReject,
  onDismiss,
}: {
  entry: LogEntry;
  showTopLine: boolean;
  showBottomLine: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDismiss: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const icon =
    entry.type === "error" ? (
      <ErrorOutlineIcon sx={{ fontSize: 16, color: "error.main" }} />
    ) : entry.type === "thinking" ? (
      <PsychologyAltOutlinedIcon sx={{ fontSize: 16, color: "text.secondary" }} />
    ) : (
      <Box sx={{ color: "text.secondary", display: "flex" }}>{getToolIcon(entry.toolName)}</Box>
    );

  return (
    <Box sx={{ display: "flex", alignItems: "stretch" }}>
      {/* 时间线列 */}
      <Box
        sx={{
          width: 24,
          flexShrink: 0,
          position: "relative",
        }}
      >
        {/* 上半段线：从顶部到 icon 中心（10px） */}
        <Box
          sx={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            top: 0,
            height: 10,
            width: 1.5,
            bgcolor: showTopLine ? "divider" : "transparent",
          }}
        />
        {/* 下半段线：从 icon 中心到底部 */}
        <Box
          sx={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            top: 10,
            bottom: 0,
            width: 1.5,
            bgcolor: showBottomLine ? "divider" : "transparent",
          }}
        />
        {/* icon — 锚定顶部，与首行内容垂直居中（首行高约 20px） */}
        <Box
          sx={{
            position: "absolute",
            top: 0,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            zIndex: 1,
            bgcolor: "background.default",
            borderRadius: "50%",
          }}
        >
          {icon}
        </Box>
      </Box>

      {/* 内容列 */}
      <Box sx={{ flex: 1, minWidth: 0, pb: 1, pl: 1, minHeight: 20 }}>
        {entry.type === "tool_call" && (
          <ToolCallStep
            entry={entry}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            onApprove={onApprove}
            onReject={onReject}
          />
        )}

        {entry.type === "thinking" && (
          <ThinkingStep
            entry={entry}
            expanded={entry.thinkingDone ? expanded : true}
            onToggle={() => setExpanded(!expanded)}
          />
        )}

        {entry.type === "error" && (
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5 }}>
            <Typography variant="body2" sx={{ color: "error.main", flex: 1, lineHeight: 1.6 }}>
              {entry.content}
            </Typography>
            <IconButton size="small" onClick={() => onDismiss(entry.id)} sx={{ mt: -0.5 }}>
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Box>
        )}
      </Box>
    </Box>
  );
}

// ── 思考步骤 ──

function ThinkingStep({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { think } = useMemo(() => splitThinkText(entry.content), [entry.content]);
  const done = !!entry.thinkingDone;
  const label = done
    ? `已思考 ${entry.thinkSeconds ?? 1} 秒`
    : "Thinking…";
  const previewSrc = think || entry.content.replace(/<\/?think>/gi, "");
  const preview = useMemo(() => {
    const firstLine = previewSrc.split("\n").find((l) => l.trim()) ?? "";
    return firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
  }, [previewSrc]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 流式中思考内容增长时，自动滚到底部
  useEffect(() => {
    if (!done && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [previewSrc, done]);
  const hasContent = !!(think || (!done && previewSrc));

  return (
    <Box>
      <Box
        onClick={hasContent ? onToggle : undefined}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          cursor: hasContent ? "pointer" : "default",
          "&:hover": hasContent ? { opacity: 0.85 } : {},
          userSelect: "none",
          minHeight: 20,
        }}
      >
        <Typography
          variant="body2"
          sx={{ fontWeight: 500, color: "text.secondary", fontStyle: done ? "normal" : "italic", lineHeight: "20px" }}
        >
          {label}
        </Typography>
        {!done && <CircularProgress size={12} />}
        {!expanded && preview && (
          <Typography
            variant="caption"
            sx={{ opacity: 0.4, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}
          >
            {preview}
          </Typography>
        )}
        {hasContent && (
          <ExpandMoreIcon
            sx={{
              fontSize: 16,
              transform: expanded ? "rotate(180deg)" : "none",
              transition: "transform 0.2s",
              opacity: 0.4,
              ml: "auto",
            }}
          />
        )}
      </Box>
      <Collapse in={expanded}>
        <Box
          ref={scrollRef}
          sx={{
            mt: 0.5,
            pl: 1,
            opacity: 0.75,
            maxHeight: 200,
            overflowY: "auto",
            ...markdownSx,
            fontSize: "0.85rem",
            "& p": { fontSize: "0.85rem", my: 0.5 },
          }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{think || previewSrc}</ReactMarkdown>
        </Box>
      </Collapse>
    </Box>
  );
}

// ── 工具调用步骤 ──

function ToolCallStep({
  entry,
  expanded,
  onToggle,
  onApprove,
  onReject,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const hasResult = entry.toolResult !== undefined;
  const isScreenshot = entry.toolName === "screenshot";
  const isPending = !hasResult && entry.needsPermission && !entry.permissionResolved;
  const isExecuting = !hasResult && (!entry.needsPermission || entry.permissionResolved);

  return (
    <Box>
      {/* 操作标签 */}
      <Box
        onClick={hasResult ? onToggle : undefined}
        sx={{
          display: "flex", alignItems: "center", gap: 0.75,
          cursor: hasResult ? "pointer" : "default",
          "&:hover": hasResult ? { opacity: 0.8 } : {},
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 500, color: "text.secondary", lineHeight: "20px" }}>
          {getToolLabel(entry.toolName)}
        </Typography>

        {isExecuting && <CircularProgress size={12} />}

        {hasResult && entry.toolSuccess && (
          <CheckCircleOutlineIcon sx={{ fontSize: 14, color: "success.main" }} />
        )}
        {hasResult && !entry.toolSuccess && (
          <ErrorOutlineIcon sx={{ fontSize: 14, color: "error.main" }} />
        )}

        {hasResult && (
          <ExpandMoreIcon
            sx={{
              fontSize: 16,
              transform: expanded ? "rotate(180deg)" : "none",
              transition: "transform 0.2s",
              opacity: 0.4,
            }}
          />
        )}
      </Box>

      {/* 截图缩略图 — 可折叠 */}
      {isScreenshot && entry.screenshotData && (
        <Collapse in={expanded}>
          <Box
            component="img"
            src={`data:image/png;base64,${entry.screenshotData}`}
            sx={{
              width: 80, height: 50, objectFit: "cover",
              borderRadius: 1, mt: 0.5, border: 1, borderColor: "divider", display: "block",
            }}
          />
        </Collapse>
      )}

      {/* 权限确认 */}
      {isPending && (
        <Stack direction="row" gap={1} sx={{ mt: 0.75 }}>
          <Button size="small" variant="outlined" onClick={() => onApprove(entry.toolCallId!)}>
            允许
          </Button>
          <Button size="small" variant="outlined" color="error" onClick={() => onReject(entry.toolCallId!)}>
            拒绝
          </Button>
        </Stack>
      )}

      {/* 可折叠结果 */}
      {hasResult && !isScreenshot && (
        <Collapse in={expanded}>
          <Typography
            component="pre"
            variant="caption"
            sx={{
              fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all",
              opacity: 0.6, mt: 0.5, maxHeight: 200, overflow: "auto",
              fontSize: "0.72rem", lineHeight: 1.4,
            }}
          >
            {entry.toolResult}
          </Typography>
        </Collapse>
      )}
    </Box>
  );
}
