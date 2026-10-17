import type { KiroEffort } from "./constants";

export type { KiroEffort };

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
  | {
      role: "assistant";
      content: OmpContent[];
      timestamp?: number;
      provider?: string;
      responseId?: string;
      stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
    }
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
}

export interface StreamOptionsLike {
  apiKey?: string;
  signal?: AbortSignal;
  /** OMP session workspace; falls back to the process working directory. */
  cwd?: string;
  /** OMP routes provider HTTP through this override when set. */
  fetch?: typeof fetch;
  /** OMP cap on a server-requested retry wait; 0 disables it. Defaults to 60s. */
  maxRetryDelayMs?: number;
  /** OMP hook that replaces the provider's own retry sleep. */
  providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  toolChoice?:
    | "auto"
    | "none"
    | "any"
    | "required"
    | { type: "function"; name: string }
    | { type: "function"; function: { name: string } }
    | { type: "tool"; name: string }
    | { type: "computer" };
  reasoning?: KiroEffort;
  disableReasoning?: boolean;
  forceReasoningOff?: boolean;
  maxTokens?: number;
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

export interface KiroImage {
  format: "png" | "jpeg" | "gif" | "webp";
  source: { bytes: string };
}

export interface KiroUserInputMessage {
  content: string;
  images?: KiroImage[];
  modelId?: string;
  origin: "KIRO_CLI" | "AI_EDITOR";
  userInputMessageContext?: {
    envState?: {
      operatingSystem: string;
      currentWorkingDirectory: string;
    };
    tools?: KiroToolSpecification[];
    toolResults?: KiroToolResult[];
  };
}

export type KiroReasoningContent = { signature: string } | { redactedContent: string };

export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: {
    content: string;
    toolUses?: KiroToolUse[];
    reasoningContent?: KiroReasoningContent;
  };
}

export interface KiroRequestPayload {
  conversationState: {
    chatTriggerType: "MANUAL";
    conversationId: string;
    agentTaskType?: "vibe";
    currentMessage: { userInputMessage: KiroUserInputMessage & { modelId: string } };
    history?: KiroHistoryEntry[];
  };
  profileArn?: string;
  additionalModelRequestFields?: {
    reasoning?: { effort: KiroEffort | "none" };
    thinking?: { type: "adaptive"; display: "summarized" };
    output_config?: { effort: KiroEffort };
  };
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
  credits?: {
    cost?: number;
    committedCost?: number;
    acuCost?: number;
  };
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
  errorId?: number;
  errorClassificationMessage?: string;
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
