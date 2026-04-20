// Tool 类型定义

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParam>;
  required?: string[];
}

export interface ToolParam {
  type: "string" | "number" | "boolean" | "integer";
  description: string;
  enum?: string[];
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// OpenAI function calling 格式
export function toOpenAiFunction(tool: ToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: tool.parameters,
        required: tool.required ?? [],
      },
    },
  };
}
