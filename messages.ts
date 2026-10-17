import { createHash, randomUUID } from "node:crypto";
import { KIRO_EFFORTS, type KiroEffort } from "./constants";
import { buildKiroToolCatalog, createToolNameRegistry } from "./schema";
import type {
  BuiltKiroRequest,
  KiroHistoryEntry,
  KiroImage,
  KiroReasoningContent,
  KiroToolResult,
  KiroToolUse,
  KiroRequestPayload,
  KiroUserInputMessage,
  OmpContent,
  OmpContext,
  OmpTool,
  StreamOptionsLike,
} from "./types";

const CONTINUATION = "Continue from the prior conversation. Do not quote or mention this instruction.";
const EMPTY_RESULT = "The tool completed without textual output.";
// Same placeholders OMP's transformMessages synthesizes for built-in providers.
const MISSING_RESULT = "No result provided";
const ABORTED_RESULT = "aborted";
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

/**
 * Kiro has no tool_choice field. Like OMP's transports without native forcing,
 * narrow the offered catalog: `none` offers nothing, a named choice offers only
 * that tool, and `any`/`required` keep every tool (the model still decides).
 */
function offeredTools(tools: readonly OmpTool[], toolChoice: StreamOptionsLike["toolChoice"]): readonly OmpTool[] {
  if (toolChoice === "none") return [];
  if (toolChoice === undefined || typeof toolChoice === "string") return tools;
  const name = toolChoice.type === "computer"
    ? "computer"
    : "function" in toolChoice ? toolChoice.function.name : toolChoice.name;
  const selected = tools.filter(tool => tool.name === name);
  return selected.length > 0 ? selected : tools;
}

const VALID_EFFORTS = new Set<string>(KIRO_EFFORTS);

const NATIVE_EFFORT_FIELDS: Record<string, "reasoning" | "thinking_output_config"> = {
  "gpt-5.6-sol": "reasoning",
  "gpt-5.6-terra": "reasoning",
  "gpt-5.6-luna": "reasoning",
  "gpt-6-sol": "reasoning",
  "gpt-6-luna": "reasoning",
  "claude-opus-4.6": "thinking_output_config",
  "claude-opus-4.7": "thinking_output_config",
  "claude-opus-4.8": "thinking_output_config",
  "claude-opus-5": "thinking_output_config",
  "claude-opus-5.5": "thinking_output_config",
  "claude-sonnet-4.6": "thinking_output_config",
  "claude-sonnet-5": "thinking_output_config",
  "claude-sonnet-5.5": "thinking_output_config",
  "kimi-k3": "thinking_output_config",
};

const EFFORT_RATIOS: Record<KiroEffort, number> = {
  low: 0.20,
  medium: 0.50,
  high: 0.80,
  xhigh: 0.90,
  max: 0.95,
};

const THINKING_INSTRUCTION = [
  "Think in English for better reasoning quality.",
  "Be thorough and systematic, consider edge cases, challenge assumptions, and verify reasoning before answering.",
  "After thinking, respond in the user's language.",
].join("\n");

type Turn =
  | { kind: "user"; content: string; toolResults: KiroToolResult[]; images: KiroImage[] }
  | { kind: "assistant"; content: string; toolUses: KiroToolUse[]; reasoningContent?: KiroReasoningContent };

function append(target: string, next: string): string {
  if (!next) return target;
  return target ? `${target}\n\n${next}` : next;
}

function contentText(content: string | OmpContent[] | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.filter((part): part is { type: "text"; text: string } => part.type === "text" && "text" in part && typeof part.text === "string").map(part => part.text).join("");
}

function imageFormat(mimeType: string): KiroImage["format"] {
  switch (mimeType.toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg": return "jpeg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: throw new Error(`Unsupported Kiro image MIME type ${JSON.stringify(mimeType)}`);
  }
}

function toKiroImage(image: { data: string; mimeType: string }): KiroImage {
  if (typeof image.data !== "string" || typeof image.mimeType !== "string") {
    throw new Error("Kiro image MIME type and data must be strings");
  }
  const format = imageFormat(image.mimeType);
  let bytes = image.data;
  if (bytes.startsWith("data:")) {
    const comma = bytes.indexOf(",");
    const header = comma >= 0 ? bytes.slice(5, comma) : "";
    const [embeddedMime, encoding] = header.split(";");
    if (encoding !== "base64" || embeddedMime.toLowerCase() !== `image/${format}`) {
      throw new Error("Kiro image data URL must contain matching base64 MIME metadata");
    }
    bytes = comma >= 0 ? bytes.slice(comma + 1) : "";
  }
  if (!bytes || bytes.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes)) {
    throw new Error("Kiro image data must be nonempty canonical base64");
  }
  const padding = bytes.endsWith("==") ? 2 : bytes.endsWith("=") ? 1 : 0;
  if (Math.floor(bytes.length * 3 / 4) - padding > MAX_IMAGE_BYTES) {
    throw new Error(`Kiro image exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  }
  const decoded = Buffer.from(bytes, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== bytes) {
    throw new Error("Kiro image data must be nonempty canonical base64");
  }
  if (decoded.length > MAX_IMAGE_BYTES) {
    throw new Error(`Kiro image exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  }
  return { format, source: { bytes } };
}

function normalizedToolId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (cleaned === id && cleaned.length >= 1 && cleaned.length <= 64) return cleaned;
  const base = cleaned.slice(0, 51) || "toolu";
  return `${base}_${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}

function normalizeKiroModelId(id: string): string {
  let model = id.trim().toLowerCase().replace(/^kiro\//, "").replace(/^kiro-/, "");
  if (model === "auto") return "auto";
  model = model.replace(/-\d{8}$/, "").replace(/-(low|medium|high|xhigh|max)$/, "");
  model = model.replace(/(\d+)-(\d+)/g, "$1.$2");
  return model.replace(/^claude-([\d.]+)-(sonnet|opus|haiku)$/, "claude-$2-$1");
}

function conversationId(context: OmpContext): string {
  // Kiro may return its conversation ID on an assistant response. Reuse only
  // bounded, printable IDs from our own provider; never infer one from prompts,
  // since unrelated conversations can start with identical text.
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message.role !== "assistant" || message.provider !== "kiro-native") continue;
    if (typeof message.responseId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(message.responseId)) {
      return message.responseId;
    }
  }
  return randomUUID();
}

function pushUser(turns: Turn[], content: string, toolResults: KiroToolResult[] = [], images: KiroImage[] = []): void {
  const last = turns.at(-1);
  if (last?.kind === "user") {
    last.content = append(last.content, content);
    last.toolResults.push(...toolResults);
    last.images.push(...images);
  } else {
    turns.push({ kind: "user", content, toolResults: [...toolResults], images: [...images] });
  }
}

function pushAssistant(
  turns: Turn[],
  content: string,
  toolUses: KiroToolUse[],
  reasoningContent?: KiroReasoningContent,
): void {
  const last = turns.at(-1);
  if (last?.kind === "assistant") {
    last.content = append(last.content, content);
    last.toolUses.push(...toolUses);
    if (reasoningContent) last.reasoningContent = reasoningContent;
  } else {
    turns.push({ kind: "assistant", content, toolUses: [...toolUses], ...(reasoningContent ? { reasoningContent } : {}) });
  }
}

export function buildKiroRequest(
  context: OmpContext,
  modelId: string,
  options?: StreamOptionsLike,
  reserveToolNames: readonly string[] = [],
  wireClient: "cli" | "ide" = "cli",
): BuiltKiroRequest {
  const registry = createToolNameRegistry();
  const wireModelId = normalizeKiroModelId(modelId);
  const catalog = buildKiroToolCatalog(offeredTools(context.tools ?? [], options?.toolChoice), wireModelId, registry, reserveToolNames);
  const turns: Turn[] = [];
  const priorCalls = new Map<string, { rawId: string; name: string }>();
  // Kiro requires every assistant toolUse to be answered in the next user turn.
  // OMP hands custom providers raw history, so pair calls here the way its
  // built-in transformMessages does: missing results become error results.
  let pending = new Map<string, string>();
  let missingResultText = MISSING_RESULT;
  const flushPending = () => {
    for (const toolUseId of pending.keys()) {
      pushUser(turns, "", [{ toolUseId, status: "error", content: [{ text: missingResultText }] }]);
    }
    pending = new Map();
  };

  for (const msg of context.messages) {
    if (msg.role === "user" || msg.role === "developer") {
      flushPending();
      const images = Array.isArray(msg.content)
        ? msg.content.filter((part): part is Extract<OmpContent, { type: "image" }> => part.type === "image").map(toKiroImage)
        : [];
      pushUser(turns, contentText(msg.content), [], images);
      continue;
    }
    if (msg.role === "assistant") {
      flushPending();
      const text = contentText(msg.content);
      const toolUses: KiroToolUse[] = [];
      let reasoningContent: KiroReasoningContent | undefined;
      for (const part of msg.content) {
        // Only our stream's tagged blobs can be replayed: signature and
        // redactedContent are distinct wire fields, not interchangeable bytes.
        if (part.type === "thinking" && part.thinkingSignature) {
          const signature = part.thinkingSignature;
          if (signature.startsWith("kiro:signature:") && signature.length > "kiro:signature:".length) {
            reasoningContent = { signature: signature.slice("kiro:signature:".length) };
          } else if (signature.startsWith("kiro:redactedContent:") && signature.length > "kiro:redactedContent:".length) {
            reasoningContent = { redactedContent: signature.slice("kiro:redactedContent:".length) };
          }
        }
        if (part.type !== "toolCall") continue;
        const name = registry.alias(part.name);
        const toolUseId = normalizedToolId(part.id);
        if (priorCalls.has(toolUseId)) throw new Error(`duplicate Kiro tool use id ${toolUseId}`);
        priorCalls.set(toolUseId, { rawId: part.id, name });
        pending.set(toolUseId, part.id);
        toolUses.push({ name, input: part.arguments ?? {}, toolUseId });
      }
      missingResultText = msg.stopReason === "error" || msg.stopReason === "aborted" ? ABORTED_RESULT : MISSING_RESULT;
      if (text || toolUses.length > 0) pushAssistant(turns, text, toolUses, reasoningContent);
      continue;
    }
    if (msg.role !== "toolResult") throw new Error("Unsupported Kiro message role");
    const toolUseId = normalizedToolId(msg.toolCallId);
    const text = contentText(msg.content);
    const images = msg.content
      .filter((part): part is Extract<typeof part, { type: "image" }> => part.type === "image")
      .map(toKiroImage);
    if (pending.get(toolUseId) === msg.toolCallId) {
      pending.delete(toolUseId);
      const lastTurn = turns.at(-1);
      const toolResultHasPeers = pending.size > 0 || (lastTurn?.kind === "user" && lastTurn.toolResults.length > 0);
      const imageLabel = images.length ? `[image:${images.map(image => image.format).join(",")}]` : "";
      const resultText = text.trim()
        ? text
        : imageLabel || EMPTY_RESULT;
      pushUser(turns, "", [{
        toolUseId,
        status: msg.isError ? "error" : "success",
        content: [{ text: toolResultHasPeers && imageLabel ? `${resultText}\n${imageLabel}` : resultText }],
      }], images);
      continue;
    }
    // A late or duplicate result for an already-answered call would break
    // adjacency; drop it. An orphan (its call folded away by compaction) keeps
    // its text as plain user content once no result window is open.
    if (priorCalls.has(toolUseId) || pending.size > 0 || (!text.trim() && !images.length)) continue;
    const errorAttr = msg.isError ? ' is-error="true"' : "";
    const orphanText = text.trim() || `[image:${images.map(image => image.format).join(",")}]`;
    pushUser(turns, `<stale-tool-result tool="${msg.toolName}" id="${msg.toolCallId}"${errorAttr}>\n${orphanText}${images.length && text.trim() ? `\n[image:${images.map(image => image.format).join(",")}]` : ""}\n</stale-tool-result>`, [], images);
  }
  flushPending();

  if (turns.length === 0 || turns[0].kind === "assistant") turns.unshift({ kind: "user", content: CONTINUATION, toolResults: [], images: [] });
  if (turns.at(-1)?.kind === "assistant") turns.push({ kind: "user", content: CONTINUATION, toolResults: [], images: [] });

  const current = turns.pop();
  if (!current || current.kind !== "user") throw new Error("Kiro request must end with a user turn");
  const isContinuation = current.content === CONTINUATION;
  const hasToolResults = current.toolResults.length > 0;
  const systemPrompt = typeof context.systemPrompt === "string" ? context.systemPrompt : context.systemPrompt?.join("\n\n");
  const systemPrefix = systemPrompt ? `${systemPrompt}\n\n` : "";
  const toEntry = (turn: Turn): KiroHistoryEntry => turn.kind === "assistant"
    ? {
        assistantResponseMessage: {
          content: turn.content,
          ...(turn.toolUses.length ? { toolUses: turn.toolUses } : {}),
          ...(turn.reasoningContent ? { reasoningContent: turn.reasoningContent } : {}),
        },
      }
    : {
        userInputMessage: {
          content: turn.content,
          origin: wireClient === "cli" ? "KIRO_CLI" : "AI_EDITOR",
          ...(turn.images.length ? { images: turn.images } : {}),
          ...(turn.toolResults.length ? { userInputMessageContext: { toolResults: turn.toolResults } } : {}),
        },
      };
  const history = turns.map(toEntry);
  const currentMessage: KiroUserInputMessage & { modelId: string } = {
    content: current.content,
    modelId: wireModelId,
    origin: wireClient === "cli" ? "KIRO_CLI" : "AI_EDITOR",
    ...(current.images.length ? { images: current.images } : {}),
    userInputMessageContext: {
      envState: {
        operatingSystem: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform,
        currentWorkingDirectory: options?.cwd ?? process.cwd(),
      },
      ...(current.toolResults.length ? { toolResults: current.toolResults } : {}),
      ...(catalog.tools.length ? { tools: catalog.tools } : {}),
    },
  };
  if (systemPrefix) {
    const firstUser = history.find(entry => entry.userInputMessage)?.userInputMessage;
    if (firstUser) firstUser.content = systemPrefix + firstUser.content;
    else currentMessage.content = systemPrefix + currentMessage.content;
  }

  const reasoning = options?.reasoning as KiroEffort | "none" | undefined;
  const explicitReasoningOff =
    options?.disableReasoning === true ||
    options?.forceReasoningOff === true ||
    reasoning === "none";
  const isReasoningOff = explicitReasoningOff || !reasoning;
  let additionalModelRequestFields: KiroRequestPayload["additionalModelRequestFields"];

  if (explicitReasoningOff && NATIVE_EFFORT_FIELDS[wireModelId] === "reasoning") {
    additionalModelRequestFields = { reasoning: { effort: "none" } };
  } else if (!isReasoningOff) {
    if (typeof reasoning !== "string" || !VALID_EFFORTS.has(reasoning)) {
      throw new Error(`Kiro ${wireModelId} does not support reasoning effort ${JSON.stringify(reasoning)}`);
    }
    const effort = reasoning as KiroEffort;
    let nativeField: "reasoning" | "thinking_output_config" | undefined;
    if ((wireModelId === "gpt-5.6-terra" || wireModelId === "gpt-5.6-luna") && effort === "xhigh") {
      nativeField = undefined;
    } else {
      nativeField = NATIVE_EFFORT_FIELDS[wireModelId];
    }

    if (nativeField === "reasoning") {
      additionalModelRequestFields = { reasoning: { effort } };
    } else if (nativeField === "thinking_output_config") {
      additionalModelRequestFields = {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
      };
    } else if (!isContinuation && !hasToolResults) {
      const maxTokens = options?.maxTokens || 4096;
      const ratio = EFFORT_RATIOS[effort];
      const budget = Math.max(1, Math.floor(maxTokens * ratio));
      currentMessage.content = [
        "<thinking_mode>enabled</thinking_mode>",
        `<max_thinking_length>${budget}</max_thinking_length>`,
        `<thinking_instruction>${THINKING_INSTRUCTION}</thinking_instruction>`,
        "",
        currentMessage.content,
      ].join("\n");
    }
  }

  const payload: KiroRequestPayload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      ...(wireClient === "cli" ? { agentTaskType: "vibe" as const } : {}),
      conversationId: conversationId(context),
      currentMessage: { userInputMessage: currentMessage },
      ...(history.length ? { history } : {}),
    },
    ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
  };
  return { payload, registry, omittedTools: catalog.omitted };
}

export function allKiroEntries(payload: KiroRequestPayload): KiroHistoryEntry[] {
  return [
    ...(payload.conversationState.history ?? []),
    { userInputMessage: payload.conversationState.currentMessage.userInputMessage },
  ];
}

export function validateKiroConversation(payload: KiroRequestPayload): void {
  let previous: "user" | "assistant" | undefined;
  for (const entry of allKiroEntries(payload)) {
    const user = entry.userInputMessage;
    const assistant = entry.assistantResponseMessage;
    if (Boolean(user) === Boolean(assistant)) throw new Error("Kiro entry must contain exactly one role");
    const role = user ? "user" : "assistant";
    if (role === previous) throw new Error(`Kiro roles must alternate; repeated ${role}`);
    previous = role;
    if (user) {
      if (!user.content.trim() && !user.userInputMessageContext?.toolResults?.length && !user.images?.length) throw new Error("Kiro user message is empty");
      for (const { toolUseId, content } of user.userInputMessageContext?.toolResults ?? []) {
        if (!toolUseId) throw new Error("Kiro tool result is missing its id");
        if (!content.length || content.some(block => !block.text.trim())) throw new Error(`Kiro tool result is empty ${toolUseId}`);
      }
    } else {
      if (!assistant?.content.trim() && !assistant?.toolUses?.length) throw new Error("Kiro assistant message is empty");
    }
  }
}
