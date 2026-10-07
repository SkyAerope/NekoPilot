import type { TargetTab } from "../shared/target-tab";
import type { ScreenshotRef } from "../shared/assets";
import type { ChatAttachment } from "../shared/attachments";

export interface PickedElement {
  id: number;
  tag: string;
  selector: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
}

export interface Attachment {
  id: number;
  name: string;
  type: string;
  size: number;
  file: File;
}

export interface LogEntry {
  id: number;
  type: "user" | "assistant" | "thinking" | "tool_call" | "error" | "pending";
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolResult?: string;
  toolSuccess?: boolean;
  needsPermission?: boolean;
  permissionResolved?: boolean;
  screenshotData?: string;
  screenshotMime?: string;
  screenshot?: ScreenshotRef;
  prunedFromContext?: boolean;
  pickedElements?: PickedElement[];
  attachmentNames?: string[];
  attachments?: ChatAttachment[];
  targetTab?: TargetTab;
  showTargetTabChip?: boolean;
  // thinking 相关
  thinkingDone?: boolean;
  thinkSeconds?: number;
}

export function finishThinking(
  entries: LogEntry[],
  now = Date.now(),
): LogEntry[] {
  if (
    !entries.some((entry) => entry.type === "thinking" && !entry.thinkingDone)
  ) {
    return entries;
  }
  return entries.map((entry) =>
    entry.type === "thinking" && !entry.thinkingDone
      ? {
          ...entry,
          thinkingDone: true,
          thinkSeconds:
            entry.thinkSeconds ??
            Math.max(1, Math.round((now - entry.timestamp) / 1000)),
        }
      : entry,
  );
}

/** 将含 <think>...</think> 或 <thinking>...</thinking> 的原始内容拆为思考与正文。
 *  仅当存在闭合标签时才会拆出 body；否则全部视为思考中。 */
export function splitThinkText(raw: string): { think: string; body: string } {
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

export function getToolLabel(name?: string): string {
  const labels: Record<string, string> = {
    execute_js: "执行 JS 代码",
    screenshot: "截图",
    read_page_text: "读取页面文本",
    read_page: "读取页面结构",
    read_page_interactive: "查找可交互元素",
    click: "点击",
    keyboard_type: "输入文本",
    scroll: "滚动页面",
    hover: "悬停鼠标",
    handle_dialog: "与对话框交互",
    navigate: "打开网址",
    wait: "等待",
    find_element: "查找元素",
    get_element_text: "读取元素文本",
    get_element_rect: "获取元素位置与尺寸",
    drag: "拖拽",
  };
  return labels[name ?? ""] ?? name ?? "工具";
}

/** 从工具的原始 args (JSON 字符串) 中提取一段简短的副标题，用于在审批时让用户看到关键参数 */
export function getToolSubtitle(name?: string, argsStr?: string): string {
  if (!name || !argsStr) return "";
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsStr);
  } catch {
    return "";
  }
  const trim = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + "…" : s);
  switch (name) {
    case "execute_js":
      return typeof args.description === "string" ? args.description : "";
    case "navigate":
      return typeof args.url === "string" ? args.url : "";
    case "keyboard_type": {
      const text = typeof args.text === "string" ? args.text : "";
      const key = typeof args.key === "string" ? args.key : "";
      if (text) return `"${trim(text, 40)}"`;
      if (key) return key;
      return "";
    }
    case "click":
      if (typeof args.selector === "string") return trim(args.selector, 50);
      if (typeof args.x === "number" && typeof args.y === "number")
        return `(${args.x}, ${args.y})`;
      return "";
    case "find_element":
      return typeof args.text === "string" ? `"${trim(args.text, 40)}"` : "";
    case "wait":
      return typeof args.ms === "number" ? `${args.ms}ms` : "";
    case "scroll":
      return typeof args.deltaY === "number" ? `Δy=${args.deltaY}` : "";
    default:
      return "";
  }
}

export function formatToolArgsMarkdown(
  name?: string,
  argsStr?: string,
): string {
  if (!argsStr) return "";

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsStr);
  } catch {
    return `\`\`\`text\n${escapeMarkdownCodeFence(argsStr)}\n\`\`\``;
  }

  if (name === "execute_js") {
    const parts: string[] = [];
    if (typeof args.description === "string" && args.description.trim()) {
      parts.push(`**Description**\n\n${args.description.trim()}`);
    }
    if (typeof args.code === "string" && args.code.trim()) {
      parts.push(
        `**Code**\n\n\`\`\`js\n${escapeMarkdownCodeFence(args.code)}\n\`\`\``,
      );
    }
    return parts.join("\n\n");
  }

  return `\`\`\`json\n${escapeMarkdownCodeFence(JSON.stringify(args, null, 2))}\n\`\`\``;
}

export function formatToolResultMarkdown(
  name?: string,
  result?: string,
): string {
  if (!result) return "";
  if (name === "execute_js") {
    return `\`\`\`json\n${escapeMarkdownCodeFence(result)}\n\`\`\``;
  }
  if (/^(\{|\[)/.test(result.trim())) {
    return `\`\`\`json\n${escapeMarkdownCodeFence(result)}\n\`\`\``;
  }
  return result;
}

// ── 日志分段 ──

export type LogSegment =
  | { kind: "user"; entry: LogEntry }
  | { kind: "assistant"; entry: LogEntry }
  | { kind: "steps"; entries: LogEntry[] };

export type Turn =
  | { kind: "user"; segment: LogSegment & { kind: "user" } }
  | { kind: "model"; segments: LogSegment[]; firstId: number };

export function groupLogs(logs: LogEntry[]): LogSegment[] {
  const segments: LogSegment[] = [];
  let currentSteps: LogEntry[] = [];
  const flushSteps = () => {
    if (currentSteps.length > 0) {
      segments.push({ kind: "steps", entries: [...currentSteps] });
      currentSteps = [];
    }
  };
  for (const entry of logs) {
    // 流式正文可能先到达空占位；保留原始日志，但不切断可见步骤。
    if (entry.type === "assistant" && !entry.content.trim()) continue;
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

export function groupIntoTurns(segments: LogSegment[]): Turn[] {
  const turns: Turn[] = [];
  let modelSegs: LogSegment[] = [];
  let modelFirstId = 0;
  const flushModel = () => {
    if (modelSegs.length > 0) {
      turns.push({
        kind: "model",
        segments: [...modelSegs],
        firstId: modelFirstId,
      });
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

export function escapeMarkdownCodeFence(content: string): string {
  return content.replace(/```/g, "``\\`");
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
