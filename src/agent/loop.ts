// Agent Loop — observe → think → act → observe 循环

import type { ToolExecutor } from "../tools/executor";
import { toolDefinitions } from "../tools/definitions";
import { toOpenAiFunction } from "../tools/types";
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

      for (const toolCall of response.tool_calls) {
        if (this.aborted) break;
        await this.executeToolCall(toolCall);
      }
    }

    const msg = "达到最大迭代次数，Agent 停止。";
    this.emit({ type: "done", data: msg });
    return { text: msg, messages: this.messages.slice(1) };
  }

  private async callLlm(): Promise<ChatMessage> {
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

  private static readonly READONLY_TOOLS = new Set([
    "screenshot", "read_page_text", "read_page", "read_page_interactive",
    "find_element", "get_element_text", "get_element_rect", "wait",
  ]);

  private async executeToolCall(toolCall: ToolCall): Promise<void> {
    const { name, arguments: argsStr } = toolCall.function;
    const needsPermission = this.config.permissionMode === "ask" && !AgentLoop.READONLY_TOOLS.has(name);

    this.emit({
      type: "tool_call",
      data: { name, args: argsStr, id: toolCall.id, needsPermission },
    });

    // 在 ask 模式下，仅对非只读工具等待用户确认
    if (needsPermission) {
      // click 工具显示坐标标记
      let showedMarker = false;
      if (name === "click" && this.config.showClickMarker) {
        try {
          const args = JSON.parse(argsStr);
          const x = args.x as number | undefined;
          const y = args.y as number | undefined;
          if (x !== undefined && y !== undefined) {
            await this.tools.showClickMarker(x, y);
            showedMarker = true;
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
      this.messages.push({
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
