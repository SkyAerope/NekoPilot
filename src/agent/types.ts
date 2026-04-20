// Agent 类型定义

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxIterations: number;
  permissionMode: "ask" | "auto";
}

export type AgentEventType =
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "message"
  | "error"
  | "done";

export interface AgentEvent {
  type: AgentEventType;
  data: unknown;
}

export type MessageContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}
