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
- 使用 jsClick 或 jsSet 时无需将元素滚动至视口内。处理视口较小，但需要操作大量元素的页面更高效
- 每次操作后用 screenshot 确认结果
- 如果操作失败，尝试其他方法`;

export class AgentLoop {
  private messages: ChatMessage[] = [];
  private aborted = false;
  private permissionResolve: ((approved: boolean) => void) | null = null;

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
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ];

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (this.aborted) {
        this.emit({ type: "done", data: "Agent was stopped." });
        return { text: "Agent was stopped.", messages: this.messages.slice(1) };
      }

      let response: ChatMessage;
      try {
        response = await this.callLlm();
      } catch (err) {
        const errorMsg = String(err);
        this.emit({ type: "error", data: errorMsg });
        this.emit({ type: "done", data: errorMsg });
        return { text: errorMsg, messages: this.messages.slice(1) };
      }

      // 如果没有 tool_calls，说明 agent 回复了最终结果
      if (!response.tool_calls || response.tool_calls.length === 0) {
        const rawContent = response.content ?? "";
        const text = typeof rawContent === "string" ? rawContent : rawContent.filter(p => p.type === "text").map(p => (p as { type: "text"; text: string }).text).join("");
        this.messages.push({ role: "assistant", content: text });
        // 流式已经通过 message_delta 发送了内容，这里只发 done
        this.emit({ type: "done", data: text });
        return { text, messages: this.messages.slice(1) };
      }

      // 有 tool_calls，执行
      // 流式已经通过 thinking_delta 发送了 content
      this.messages.push(response);

      const deferredMessages: ChatMessage[] = [];
      for (const toolCall of response.tool_calls) {
        if (this.aborted) break;
        await this.executeToolCall(toolCall, deferredMessages);
      }
      // 将截图等需要延迟的消息追加到所有 tool_result 之后
      this.messages.push(...deferredMessages);
    }

    const msg = "达到最大迭代次数，Agent 停止。";
    this.emit({ type: "done", data: msg });
    return { text: msg, messages: this.messages.slice(1) };
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
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM API error ${resp.status}: ${text}`);
    }

    // 解析 SSE 流
    let content = "";
    const toolCallsMap = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
    let hasContent = false;
    let hasToolCalls = false;
    // 追踪是否已经发过起始事件
    let messageStarted = false;
    let thinkingStarted = false;

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

        // 累积 content
        if (delta.content) {
          content += delta.content;
          hasContent = true;

          // 在流式过程中还不知道最终有没有 tool_calls
          // 先以 message_delta 发送，如果后续发现有 tool_calls 再切换
          if (!hasToolCalls) {
            if (!messageStarted) {
              this.emit({ type: "message", data: "" });
              messageStarted = true;
            }
            this.emit({ type: "message_delta", data: delta.content });
          } else {
            if (!thinkingStarted) {
              this.emit({ type: "thinking", data: "" });
              thinkingStarted = true;
            }
            this.emit({ type: "thinking_delta", data: delta.content });
          }
        }

        // 累积 tool_calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsMap.has(idx)) {
              hasToolCalls = true;
              // 第一次出现 tool_call，如果之前以 message 发过 content，需要通知 UI 切换为 thinking
              if (messageStarted && !thinkingStarted && content) {
                // 替换：之前的 message 其实是 thinking
                this.emit({ type: "message_to_thinking", data: null });
                thinkingStarted = true;
              }
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
    let thinkingStarted = false;

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
            // 如果已经有 content 且这是第一个 tool_use，通知 UI 切换
            if (messageStarted && !thinkingStarted && content) {
              this.emit({ type: "message_to_thinking", data: null });
              thinkingStarted = true;
            }
          }
          continue;
        }

        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta" && delta.text) {
            content += delta.text;
            hasContent = true;
            // 判断是否有 tool_use（已经开始过），如果有则作为 thinking
            if (toolCalls.length > 0 || currentBlockType === "text" && currentToolName) {
              // 后续文本块视为 thinking（理论上 Anthropic 不会在 tool_use 后再有 text）
              if (!thinkingStarted) {
                this.emit({ type: "thinking", data: "" });
                thinkingStarted = true;
              }
              this.emit({ type: "thinking_delta", data: delta.text });
            } else {
              if (!messageStarted) {
                this.emit({ type: "message", data: "" });
                messageStarted = true;
              }
              this.emit({ type: "message_delta", data: delta.text });
            }
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
              // selector 路径：解析元素中心点
              const pos = await this.tools.resolveSelectorCenter(sel).catch(() => null);
              if (pos) {
                await this.tools.showClickMarker(pos.x, pos.y);
                showedMarker = true;
              }
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
          { type: "image_url", image_url: { url: `data:image/png;base64,${result.data}` } },
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
