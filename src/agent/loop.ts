// Agent Loop — observe → think → act → observe 循环

import type { ToolExecutor } from "../tools/executor";
import { toolDefinitions } from "../tools/definitions";
import { toOpenAiFunction, toAnthropicTool } from "../tools/types";
import type {
  AgentConfig,
  AgentEvent,
  ChatMessage,
  ToolCall,
} from "./types";

const SYSTEM_PROMPT = `你是 NekoPilot，一个浏览器自动化助手。
你可以通过 tools 控制用户当前浏览器页面。

工作流程：
1. 先用 screenshot 或 read_page 观察当前页面状态
2. 分析页面内容，规划下一步操作
3. 执行操作（click、set_input、scroll 等）
4. 再次观察确认操作结果
5. 重复直到任务完成

注意：
- 坐标基于页面视口左上角
- 使用 read_page_interactive 获取可交互元素列表更高效
- 尽量在一个回复中同时进行多次工具调用，这些工具调用会按顺序执行。
- 如果CDP使用失败，尝试使用 jsClick 或 jsSet 。
- 每次操作后用 screenshot 确认结果
- 如果操作失败，尝试其他方法`;

const SHORT_REFS_HINT = `

元素短引用（#n）：
- read_page_interactive / find_element 返回项中的 selector 字段不再是真实 CSS 选择器，而是形如 "#1"、"#2" 的短引用。
- 在后续 click / set_input / get_element_text / get_element_rect 等工具调用中，把这些 #n 直接作为 selector 参数传入即可，扩展会自动还原为真实 CSS 选择器。
- 这能显著节省 token，也避免长选择器的转义问题。仅当你需要操作未出现在最近一次 read_page_interactive / find_element 结果中的元素时，才需要自己写 CSS 选择器。`;
export class AgentLoop {
  private messages: ChatMessage[] = [];
  private aborted = false;
  private permissionResolve: ((approved: boolean) => void) | null = null;
  private httpAbortController: AbortController | null = null;

  constructor(
    private tools: ToolExecutor,
    private config: AgentConfig,
    private emit: (event: AgentEvent) => void
  ) {}

  abort(): void {
    this.aborted = true;
    if (this.permissionResolve) {
      this.permissionResolve(false);
      this.permissionResolve = null;
    }
    // 立即掐断 LLM HTTP 流
    if (this.httpAbortController) {
      try { this.httpAbortController.abort(); } catch { /* ignore */ }
      this.httpAbortController = null;
    }
  }

  resolvePermission(approved: boolean): void {
    if (this.permissionResolve) {
      this.permissionResolve(approved);
      this.permissionResolve = null;
    }
  }

  /** 运行时切换权限模式；切到 auto 时会自动放行当前等待的审批 */
  setPermissionMode(mode: "ask" | "auto"): void {
    this.config.permissionMode = mode;
    if (mode === "auto" && this.permissionResolve) {
      this.permissionResolve(true);
      this.permissionResolve = null;
    }
  }

  async run(history: ChatMessage[]): Promise<{ text: string; messages: ChatMessage[] }> {
    this.messages = [
      { role: "system", content: SYSTEM_PROMPT + (this.config.enableShortRefs ? SHORT_REFS_HINT : "") },
      ...history,
    ];

    const finishWith = (text: string, eventType: "done" | "error" = "done") => {
      this.finalizePendingToolUses();
      this.emit({ type: eventType, data: text });
      if (eventType === "error") this.emit({ type: "done", data: text });
      return { text, messages: this.messages.slice(1) };
    };

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (this.aborted) {
        return finishWith("Agent was stopped.");
      }

      let response: ChatMessage;
      try {
        response = await this.callLlm();
      } catch (err) {
        // 用户主动 abort：不要把 AbortError 当 LLM 错误透传
        if (this.aborted) {
          return finishWith("Agent was stopped.");
        }
        return finishWith(String(err), "error");
      }

      // 如果没有 tool_calls，说明 agent 回复了最终结果
      if (!response.tool_calls || response.tool_calls.length === 0) {
        const rawContent = response.content ?? "";
        const text = typeof rawContent === "string" ? rawContent : rawContent.filter(p => p.type === "text").map(p => (p as { type: "text"; text: string }).text).join("");
        this.messages.push({ role: "assistant", content: text });
        return finishWith(text);
      }

      // 有 tool_calls，执行
      this.messages.push(response);

      const deferredMessages: ChatMessage[] = [];
      for (const toolCall of response.tool_calls) {
        if (this.aborted) break;
        await this.executeToolCall(toolCall, deferredMessages);
      }
      this.messages.push(...deferredMessages);

      // 工具循环中被 abort：在退出前补齐缺失的 tool_result，然后结束
      if (this.aborted) {
        return finishWith("Agent was stopped.");
      }
    }

    return finishWith("达到最大迭代次数，Agent 停止。");
  }

  /**
   * 扫描 messages 末尾的最后一条 assistant tool_calls，
   * 给所有缺失对应 tool_result 的 tool_call 补一条占位结果，
   * 否则下一轮 LLM 调用会因 tool_use/tool_result 不匹配报 400。
   */
  private finalizePendingToolUses(): void {
    // 找到最后一条带 tool_calls 的 assistant
    let asstIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        asstIdx = i;
        break;
      }
      // 跨越 tool/user 消息继续向前找
      if (m.role === "assistant" && (!m.tool_calls || m.tool_calls.length === 0)) return;
    }
    if (asstIdx < 0) return;
    const asst = this.messages[asstIdx];
    const calls = asst.tool_calls!;
    // 收集 asstIdx 之后已存在的 tool_result 对应的 id
    const seen = new Set<string>();
    for (let i = asstIdx + 1; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === "tool" && m.tool_call_id) seen.add(m.tool_call_id);
    }
    // 找到第一个缺失 tool_result 的位置（按 calls 顺序），把缺失项补在 asst 后续的 tool 序列末尾
    const missing = calls.filter((c) => !seen.has(c.id));
    if (missing.length === 0) return;
    // 找到 tool_result 序列结尾位置，将占位插入此处（保持顺序）
    let insertAt = asstIdx + 1;
    while (insertAt < this.messages.length && this.messages[insertAt].role === "tool") insertAt++;
    const fillers: ChatMessage[] = missing.map((c) => ({
      role: "tool",
      tool_call_id: c.id,
      content: JSON.stringify({ success: false, error: "用户停止了执行，工具未运行" }),
    }));
    this.messages.splice(insertAt, 0, ...fillers);
  }


  private async callLlm(): Promise<ChatMessage> {
    if (this.config.provider === "anthropic") {
      return this.callLlmAnthropic();
    }
    return this.callLlmOpenAI();
  }

  private async callLlmOpenAI(): Promise<ChatMessage> {
    const functions = toolDefinitions.map(toOpenAiFunction);

    const body = {
      model: this.config.model,
      messages: this.messages,
      tools: functions,
      stream: true,
    };

    const resp = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: (this.httpAbortController = new AbortController()).signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM API error ${resp.status}: ${text}`);
    }

    // 解析 SSE 流
    let content = "";
    const toolCallsMap = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
    let hasContent = false;
    // 追踪是否已经发过起始事件
    let messageStarted = false;

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop()!; // 最后一行可能不完整

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // 累积 content — 统一以 message 流式发送。
        // 前端会检测到 <think> 标签后把该条目转为 thinking；无标签则视为普通 assistant 正文。
        if (delta.content) {
          content += delta.content;
          hasContent = true;

          if (!messageStarted) {
            this.emit({ type: "message", data: "" });
            messageStarted = true;
          }
          this.emit({ type: "message_delta", data: delta.content });
        }

        // 累积 tool_calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, {
                id: tc.id ?? "",
                type: "function",
                function: { name: tc.function?.name ?? "", arguments: "" },
              });
            }
            const existing = toolCallsMap.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name = tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          }
        }
      }
    }

    const toolCalls = Array.from(toolCallsMap.values()) as ToolCall[];

    this.emit({ type: "assistant_turn_done", data: "" });

    return {
      role: "assistant",
      content: hasContent ? content : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    } as ChatMessage;
  }

  // ── Anthropic Messages API ──

  /** 将内部 OpenAI 格式消息转为 Anthropic 格式 */
  private convertMessagesForAnthropic(): { system: string; messages: unknown[] } {
    let system = "";
    const out: unknown[] = [];

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];

      if (msg.role === "system") {
        system = typeof msg.content === "string" ? msg.content : "";
        continue;
      }

      if (msg.role === "user") {
        const content = msg.content;
        if (typeof content === "string") {
          this.appendAnthropicMessage(out, "user", [{ type: "text", text: content }]);
        } else if (Array.isArray(content)) {
          // 多模态 user 消息（含截图）
          const blocks = content.map((part) => {
            if (part.type === "text") return { type: "text", text: part.text };
            if (part.type === "image_url") {
              const url = part.image_url.url;
              const m = url.match(/^data:(image\/\w+);base64,(.+)$/);
              if (m) {
                return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
              }
            }
            return { type: "text", text: "[unsupported content]" };
          });
          this.appendAnthropicMessage(out, "user", blocks);
        }
        continue;
      }

      if (msg.role === "assistant") {
        const blocks: unknown[] = [];
        if (msg.content) {
          const text = typeof msg.content === "string" ? msg.content : "";
          if (text) blocks.push({ type: "text", text });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let input: unknown;
            try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
            blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
          }
        }
        if (blocks.length > 0) {
          this.appendAnthropicMessage(out, "assistant", blocks);
        }
        continue;
      }

      if (msg.role === "tool") {
        // 收集连续的 tool 消息为一个 user 消息的 tool_result blocks
        const toolBlocks: unknown[] = [];
        let j = i;
        while (j < this.messages.length && this.messages[j].role === "tool") {
          const tm = this.messages[j];
          const resultContent = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content);
          // 检查下一条是否是 user 消息带截图（对应此 tool 的截图结果）
          const next = this.messages[j + 1];
          if (resultContent === "Screenshot captured successfully." && next?.role === "user" && Array.isArray(next.content)) {
            // 将截图直接嵌入 tool_result
            const imgParts = (next.content as Array<{ type: string; image_url?: { url: string }; text?: string }>);
            const contentBlocks: unknown[] = [];
            for (const p of imgParts) {
              if (p.type === "image_url" && p.image_url) {
                const m = p.image_url.url.match(/^data:(image\/\w+);base64,(.+)$/);
                if (m) {
                  contentBlocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
                }
              }
            }
            contentBlocks.push({ type: "text", text: "Screenshot captured successfully." });
            toolBlocks.push({ type: "tool_result", tool_use_id: tm.tool_call_id, content: contentBlocks });
            j += 2; // 跳过 tool + 截图 user 消息
          } else {
            toolBlocks.push({ type: "tool_result", tool_use_id: tm.tool_call_id, content: resultContent });
            j++;
          }
        }
        this.appendAnthropicMessage(out, "user", toolBlocks);
        i = j - 1; // 外层 for 会 i++
        continue;
      }
    }

    return { system, messages: out };
  }

  /** 追加内容到 Anthropic 消息数组，合并连续同 role 消息 */
  private appendAnthropicMessage(messages: unknown[], role: string, content: unknown[]): void {
    const last = messages[messages.length - 1] as { role: string; content: unknown[] } | undefined;
    if (last && last.role === role) {
      last.content.push(...content);
    } else {
      messages.push({ role, content });
    }
  }

  private async callLlmAnthropic(): Promise<ChatMessage> {
    const tools = toolDefinitions.map(toAnthropicTool);
    const { system, messages } = this.convertMessagesForAnthropic();

    const body = {
      model: this.config.model,
      max_tokens: 4096,
      system,
      messages,
      tools,
      stream: true,
    };

    const resp = await fetch(`${this.config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: (this.httpAbortController = new AbortController()).signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM API error ${resp.status}: ${text}`);
    }

    // 解析 Anthropic SSE 流
    let content = "";
    const toolCalls: ToolCall[] = [];
    let hasContent = false;
    let messageStarted = false;

    // 当前正在构建的 content block
    let currentBlockType = "";
    let currentToolId = "";
    let currentToolName = "";
    let currentToolArgs = "";

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        let event;
        try { event = JSON.parse(data); } catch { continue; }

        if (event.type === "content_block_start") {
          const block = event.content_block;
          currentBlockType = block.type;
          if (block.type === "tool_use") {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolArgs = "";
          }
          continue;
        }

        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta" && delta.text) {
            content += delta.text;
            hasContent = true;
            // 统一发 message_delta，前端按 <think> 标签判别思考
            if (!messageStarted) {
              this.emit({ type: "message", data: "" });
              messageStarted = true;
            }
            this.emit({ type: "message_delta", data: delta.text });
          } else if (delta.type === "input_json_delta" && delta.partial_json) {
            currentToolArgs += delta.partial_json;
          }
          continue;
        }

        if (event.type === "content_block_stop") {
          if (currentBlockType === "tool_use") {
            toolCalls.push({
              id: currentToolId,
              type: "function",
              function: { name: currentToolName, arguments: currentToolArgs },
            });
          }
          currentBlockType = "";
          continue;
        }
      }
    }

    this.emit({ type: "assistant_turn_done", data: "" });

    return {
      role: "assistant",
      content: hasContent ? content : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    } as ChatMessage;
  }

  private static readonly READONLY_TOOLS = new Set([
    "screenshot", "read_page_text", "read_page", "read_page_interactive",
    "find_element", "get_element_text", "get_element_rect", "wait",
  ]);

  private async executeToolCall(toolCall: ToolCall, deferredMessages: ChatMessage[]): Promise<void> {
    const { name, arguments: argsStr } = toolCall.function;
    const needsPermission = this.config.permissionMode === "ask" && !AgentLoop.READONLY_TOOLS.has(name);

    this.emit({
      type: "tool_call",
      data: { name, args: argsStr, id: toolCall.id, needsPermission },
    });

    // click 使用 selector 时，先检查元素是否存在，不存在或选择器非法直接拒绝
    if (name === "click") {
      let parsedArgs: { selector?: unknown } | null = null;
      try { parsedArgs = JSON.parse(argsStr); } catch { /* 解析失败交给后续 */ }
      if (parsedArgs && typeof parsedArgs.selector === "string") {
        const sel = parsedArgs.selector;
        let exists = false;
        let errMsg = "";
        try {
          exists = await this.tools.checkElement(sel);
        } catch (err) {
          // 选择器语法非法等：把错误暴露给模型，不进入审批
          errMsg = String(err);
        }
        if (!exists) {
          const rejected = {
            success: false,
            error: errMsg ? `选择器无效: ${sel} (${errMsg})` : `元素未找到: ${sel}`,
          };
          this.emit({ type: "tool_result", data: { name, result: rejected, id: toolCall.id } });
          this.messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(rejected) });
          return;
        }
      }
    }

    // 在 ask 模式下，仅对非只读工具等待用户确认
    if (needsPermission) {
      // click / scroll 工具显示位置标记
      let showedMarker = false;
      if (this.config.showClickMarker) {
        try {
          const args = JSON.parse(argsStr);
          if (name === "click") {
            const x = args.x as number | undefined;
            const y = args.y as number | undefined;
            const sel = args.selector as string | undefined;
            if (sel) {
              // selector 路径：锚定元素，marker 会跟随元素位置变化
              await this.tools.showAnchoredClickMarker(sel).catch(() => {});
              showedMarker = true;
            } else if (x !== undefined && y !== undefined) {
              await this.tools.showClickMarker(x, y);
              showedMarker = true;
            }
          } else if (name === "scroll") {
            const x = args.x as number | undefined;
            const y = args.y as number | undefined;
            const dx = (args.deltaX as number | undefined) ?? 0;
            const dy = (args.deltaY as number | undefined) ?? 0;
            if (x !== undefined && y !== undefined) {
              await this.tools.showScrollMarker(x, y, dx, dy);
              showedMarker = true;
            }
          } else if (name === "set_input") {
            const sel = args.selector as string | undefined;
            if (sel) {
              await this.tools.showInputMarker(sel).catch(() => {});
              showedMarker = true;
            }
          }
        } catch { /* 解析失败忽略 */ }
      }

      const approved = await new Promise<boolean>((resolve) => {
        this.permissionResolve = resolve;
      });

      if (showedMarker) {
        await this.tools.removeClickMarker().catch(() => {});
      }

      if (!approved) {
        const rejected = { success: false, error: "用户拒绝了此操作" };
        this.emit({ type: "tool_result", data: { name, result: rejected, id: toolCall.id } });
        this.messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(rejected) });
        return;
      }
    }

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(argsStr);
    } catch {
      params = {};
    }

    const result = await this.tools.execute(name, params);

    this.emit({
      type: "tool_result",
      data: { name, result, id: toolCall.id },
    });

    // 将结果加入消息历史
    if (name === "screenshot" && result.success) {
      const shot = result.data as { data: string; mime: string } | string;
      const dataB64 = typeof shot === "string" ? shot : shot.data;
      const mime = typeof shot === "string" ? "image/png" : shot.mime;
      // tool 消息只能是字符串，图片需通过 user 消息传入
      this.messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: "Screenshot captured successfully.",
      });
      // 截图 user 消息延迟到所有 tool_result 之后，避免打断 tool_use → tool_result 序列
      deferredMessages.push({
        role: "user",
        content: [
          { type: "text", text: "[screenshot result]" },
          { type: "image_url", image_url: { url: `data:${mime};base64,${dataB64}` } },
        ],
      });
    } else {
      this.messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.data ?? result.error),
      });
    }
  }
}
