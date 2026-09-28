export type JsonRecord = Record<string, unknown>;

export interface OmpTool {
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}

export type OmpContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "toolCall"; id: string; name: string; arguments: JsonRecord };

export type OmpMessage =
  | { role: "user" | "developer"; content: string | OmpContent[]; timestamp?: number }
  | { role: "assistant"; content: OmpContent[]; timestamp?: number }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
      isError: boolean;
      timestamp?: number;
    };

export interface OmpContext {
  systemPrompt?: string | string[];
  messages: OmpMessage[];
  tools?: OmpTool[];
}

export interface ModelLike {
  id: string;
  provider: string;
  api: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface StreamOptionsLike {
  apiKey?: string;
  signal?: AbortSignal;
  toolChoice?:
    | "auto"
    | "none"
    | "any"
    | "required"
    | { type: "function"; name: string }
    | { type: "function"; function: { name: string } }
    | { type: "tool"; name: string }
    | { type: "computer" };
}

export interface KiroToolSpecification {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: JsonRecord };
  };
}

export interface KiroToolUse {
  name: string;
  input: JsonRecord;
  toolUseId: string;
}

export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}

export interface KiroUserInputMessage {
  content: string;
  origin?: "CLI" | "AI_EDITOR";
  userInputMessageContext?: {
    tools?: KiroToolSpecification[];
    toolResults?: KiroToolResult[];
  };
}

export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: {
    content: string;
    toolUses?: KiroToolUse[];
  };
}

export interface KiroRequestPayload {
  conversationState: {
    chatTriggerType: "MANUAL";
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  profileArn?: string;
}

export interface ToolNameRegistry {
  alias(name: string): string;
  restore(name: string): string;
  readonly nameMap: Map<string, string>;
}

export interface BuiltKiroRequest {
  payload: KiroRequestPayload;
  registry: ToolNameRegistry;
  omittedTools: string[];
}

export interface OmpUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface OmpAssistantMessage {
  role: "assistant";
  content: OmpContent[];
  api: string;
  provider: string;
  model: string;
  usage: OmpUsage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  responseId?: string;
  errorStatus?: number;
  errorMessage?: string;
  timestamp: number;
}

export type OmpAssistantEvent =
  | { type: "start"; partial: OmpAssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: OmpAssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: OmpAssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: OmpAssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: OmpAssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: OmpAssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: OmpAssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: OmpAssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: OmpAssistantMessage }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: Extract<OmpContent, { type: "toolCall" }>;
      partial: OmpAssistantMessage;
    }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: OmpAssistantMessage }
  | { type: "error"; reason: "error" | "aborted"; error: OmpAssistantMessage };
