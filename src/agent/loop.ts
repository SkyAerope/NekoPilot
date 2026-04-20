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
        const text = response.content ?? "";
        this.messages.push({ role: "assistant", content: text });
        this.emit({ type: "message", data: text });
        this.emit({ type: "done", data: text });
        return { text, messages: this.messages.slice(1) };
      }

      // 有 tool_calls，执行
      if (response.content) {
        this.emit({ type: "thinking", data: response.content });
      }
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

    const json = await resp.json();

    // 部分 provider 会把 content 和 tool_calls 拆到不同 choices 里，需要合并
    let content: string | null = null;
    const toolCalls: ToolCall[] = [];
    for (const choice of json.choices) {
      const msg = choice.message;
      if (msg.content && !content) content = msg.content;
      if (msg.tool_calls) toolCalls.push(...msg.tool_calls);
    }

    return {
      role: "assistant",
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    } as ChatMessage;
  }

  private async executeToolCall(toolCall: ToolCall): Promise<void> {
    const { name, arguments: argsStr } = toolCall.function;

    this.emit({
      type: "tool_call",
      data: { name, args: argsStr, id: toolCall.id, needsPermission: this.config.permissionMode === "ask" },
    });

    // 在 ask 模式下等待用户确认
    if (this.config.permissionMode === "ask") {
      const approved = await new Promise<boolean>((resolve) => {
        this.permissionResolve = resolve;
      });
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
    let content: string;
    if (name === "screenshot" && result.success) {
      // 截图返回简短提示，实际图片数据太长
      content = "[Screenshot captured successfully. Base64 image data available.]";
    } else {
      content = JSON.stringify(result.data ?? result.error);
    }

    this.messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content,
    });
  }
}
