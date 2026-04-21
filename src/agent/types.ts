// Agent 类型定义

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  permissionMode: "ask" | "auto";
  showClickMarker: boolean;
  provider: "openai" | "anthropic";
  enableShortRefs: boolean;
  screenshotQuality: number;
}

export type AgentEventType =
  | "thinking"
  | "thinking_delta"
  | "tool_call"
  | "tool_result"
  | "message"
  | "message_delta"
  | "message_to_thinking"
  | "assistant_turn_done"
  | "usage"
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
