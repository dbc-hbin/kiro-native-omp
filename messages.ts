import { createHash } from "node:crypto";
import { buildKiroToolCatalog, createToolNameRegistry } from "./schema";
import type {
  BuiltKiroRequest,
  KiroHistoryEntry,
  KiroToolResult,
  KiroToolUse,
  KiroRequestPayload,
  KiroUserInputMessage,
  OmpContent,
  OmpContext,
  StreamOptionsLike,
} from "./types";

const CONTINUATION = "Continue from the prior conversation. Do not quote or mention this instruction.";
const RESULT_CARRIER = "The requested tool result is attached.";
const EMPTY_RESULT = "The tool completed without textual output.";

type Turn =
  | { kind: "user"; content: string; toolResults: KiroToolResult[] }
  | { kind: "assistant"; content: string; toolUses: KiroToolUse[] };

function append(target: string, next: string): string {
  if (!next) return target;
  return target ? `${target}\n\n${next}` : next;
}

function contentText(content: string | OmpContent[] | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.filter((part): part is { type: "text"; text: string } => part.type === "text" && "text" in part && typeof part.text === "string").map(part => part.text).join("");
}

function normalizedToolId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (cleaned === id && cleaned.length >= 1 && cleaned.length <= 64) return cleaned;
  const base = cleaned.slice(0, 51) || "toolu";
  return `${base}_${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}

function pushUser(turns: Turn[], content: string, toolResults: KiroToolResult[] = []): void {
  const last = turns.at(-1);
  if (last?.kind === "user") {
    last.content = append(last.content, content);
    last.toolResults.push(...toolResults);
  } else {
    turns.push({ kind: "user", content, toolResults: [...toolResults] });
  }
}

function pushAssistant(
  turns: Turn[],
  content: string,
  toolUses: KiroToolUse[],
): void {
  const last = turns.at(-1);
  if (last?.kind === "assistant") {
    last.content = append(last.content, content);
    last.toolUses.push(...toolUses);
  } else {
    turns.push({ kind: "assistant", content, toolUses: [...toolUses] });
  }
}

export function buildKiroRequest(
  context: OmpContext,
  modelId: string,
  options?: StreamOptionsLike,
  reserveToolNames: readonly string[] = [],
): BuiltKiroRequest {
  const toolChoice = options?.toolChoice;
  if (toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none") {
    throw new Error(`Kiro supports only automatic tool choice or toolChoice:none, got ${JSON.stringify(toolChoice)}`);
  }
  const registry = createToolNameRegistry();
  const wireModelId = modelId.replace(/(\d)-(\d)/g, "$1.$2");
  const catalog = buildKiroToolCatalog(toolChoice === "none" ? [] : (context.tools ?? []), wireModelId, registry, reserveToolNames);
  const turns: Turn[] = [];
  const priorCalls = new Map<string, { rawId: string; name: string }>();

  for (const msg of context.messages) {
    if (msg.role === "user" || msg.role === "developer") {
      if (Array.isArray(msg.content) && msg.content.some(part => part.type === "image")) {
        throw new Error("Kiro bearer does not translate user image content");
      }
      pushUser(turns, contentText(msg.content));
      continue;
    }
    if (msg.role === "assistant") {
      const text = contentText(msg.content);
      const toolUses: KiroToolUse[] = [];
      for (const part of msg.content) {
        if (part.type !== "toolCall") continue;
        const name = registry.alias(part.name);
        const toolUseId = normalizedToolId(part.id);
        if (priorCalls.has(toolUseId)) throw new Error(`duplicate Kiro tool use id ${toolUseId}`);
        priorCalls.set(toolUseId, { rawId: part.id, name });
        toolUses.push({ name, input: part.arguments ?? {}, toolUseId });
      }
      if (text || toolUses.length > 0) pushAssistant(turns, text, toolUses);
      continue;
    }
    if (msg.role !== "toolResult") throw new Error("Unsupported Kiro message role");
    if (msg.content.some(part => part.type === "image")) {
      throw new Error("Kiro bearer does not translate tool-result image content");
    }
    const toolUseId = normalizedToolId(msg.toolCallId);
    const call = priorCalls.get(toolUseId);
    if (!call || call.rawId !== msg.toolCallId) throw new Error(`orphaned tool result ${msg.toolCallId}`);
    const text = contentText(msg.content);
    const result: KiroToolResult = {
      toolUseId,
      status: msg.isError ? "error" : "success",
      content: [{ text: text.trim() ? text : EMPTY_RESULT }],
    };
    pushUser(turns, "", [result]);
  }

  if (turns.length === 0 || turns[0].kind === "assistant") turns.unshift({ kind: "user", content: CONTINUATION, toolResults: [] });
  if (turns.at(-1)?.kind === "assistant") turns.push({ kind: "user", content: CONTINUATION, toolResults: [] });
  for (const turn of turns) if (turn.kind === "user" && !turn.content.trim() && turn.toolResults.length > 0) turn.content = RESULT_CARRIER;

  const current = turns.pop();
  if (!current || current.kind !== "user") throw new Error("Kiro request must end with a user turn");
  const systemPrompt = typeof context.systemPrompt === "string" ? context.systemPrompt : context.systemPrompt?.join("\n\n");
  const systemPrefix = systemPrompt ? `${systemPrompt}\n\n` : "";
  const toEntry = (turn: Turn): KiroHistoryEntry => turn.kind === "assistant"
    ? {
        assistantResponseMessage: {
          content: turn.content,
          ...(turn.toolUses.length ? { toolUses: turn.toolUses } : {}),
        },
      }
    : {
        userInputMessage: {
          content: turn.content,
          origin: "CLI",
          ...(turn.toolResults.length ? { userInputMessageContext: { toolResults: turn.toolResults } } : {}),
        },
      };
  const history = turns.map(toEntry);
  const currentMessage: KiroUserInputMessage = {
    content: current.content,
    origin: "CLI",
    userInputMessageContext: {
      ...(current.toolResults.length ? { toolResults: current.toolResults } : {}),
      ...(catalog.tools.length ? { tools: catalog.tools } : {}),
    },
  };
  if (systemPrefix) {
    const firstUser = history.find(entry => entry.userInputMessage)?.userInputMessage;
    if (firstUser) firstUser.content = systemPrefix + firstUser.content;
    else currentMessage.content = systemPrefix + currentMessage.content;
  }
  const payload: KiroRequestPayload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      currentMessage: { userInputMessage: currentMessage },
      ...(history.length ? { history } : {}),
    },
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
      if (!user.content.trim() && !user.userInputMessageContext?.toolResults?.length) throw new Error("Kiro user message is empty");
      for (const { toolUseId, content } of user.userInputMessageContext?.toolResults ?? []) {
        if (!toolUseId) throw new Error("Kiro tool result is missing its id");
        if (!content.length || content.some(block => !block.text.trim())) throw new Error(`Kiro tool result is empty ${toolUseId}`);
      }
    } else {
      if (!assistant?.content.trim() && !assistant?.toolUses?.length) throw new Error("Kiro assistant message is empty");
    }
  }
}
