import { BUILDER_ID_SERVICE_PROFILE_ARN } from "./constants";
import { decodeEventStream } from "./eventstream";
import { buildKiroRequest } from "./messages";
import type { JsonRecord, ModelLike, OmpAssistantEvent, OmpAssistantMessage, OmpContext, OmpContent, OmpUsage, StreamOptionsLike } from "./types";
import { Flag } from "@oh-my-pi/pi-ai/error";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";

const TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
// Match CLI 2.26.0 first-request headers without accumulating appVersion tags on retries.
const CLI_AMZ_USER_AGENT = `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"} lang/rust/1.92.0 m/F app/AmazonQ-For-CLI`;
const CLI_USER_AGENT = CLI_AMZ_USER_AGENT.replace(" m/F", " md/appVersion-2.26.0");
const textDecoder = new TextDecoder();
// Kiro's per-user request-rate throttle (HTTP 429, USER_REQUEST_RATE_EXCEEDED)
// clears within seconds. Like OpenCodex, retry it inside the provider instead of
// failing the turn; exhausted quotas are not retryable.
const MAX_SEND_ATTEMPTS = 3;
const THROTTLE_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const QUOTA_EXHAUSTED = /MONTHLY_REQUEST_COUNT|quota/i;
const IDE_VERSION = "1.1.70";
const IDE_PLATFORM = "ua/2.1 os/win32#10.0.26200 lang/js md/nodejs#24.18.0";

type OmpErrorFields = OmpAssistantMessage & { errorId?: number; errorClassificationMessage?: string };
type DoneReason = "stop" | "length" | "toolUse";

function retryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function waitForRetry(delayMs: number, options?: StreamOptionsLike): Promise<void> {
  if (options?.providerRetryWait) return options.providerRetryWait(delayMs, options.signal);
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(new Error("Request was aborted"));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    reject(new Error("Request was aborted"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, delayMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

function emptyUsage(): OmpUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

class AssistantEventStream implements AsyncIterable<OmpAssistantEvent> {
  private queue: OmpAssistantEvent[] = [];
  private waiting: Array<(value: IteratorResult<OmpAssistantEvent>) => void> = [];
  private done = false;
  private readonly finished = Promise.withResolvers<OmpAssistantMessage>();

  get hasPendingLocalWork(): boolean { return false; }

  push(event: OmpAssistantEvent): void {
    if (this.done) return;
    if (event.type === "done" || event.type === "error") {
      this.done = true;
      this.finished.resolve(event.type === "done" ? event.message : event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
    if (this.done) for (const next of this.waiting.splice(0)) next({ value: undefined, done: true });
  }

  result(): Promise<OmpAssistantMessage> { return this.finished.promise; }

  async *[Symbol.asyncIterator](): AsyncIterator<OmpAssistantEvent> {
    while (true) {
      if (this.queue.length) { yield this.queue.shift()!; continue; }
      if (this.done) return;
      const { promise, resolve } = Promise.withResolvers<IteratorResult<OmpAssistantEvent>>();
      this.waiting.push(resolve);
      const next = await promise;
      if (next.done) return;
      yield next.value;
    }
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function reasonToken(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function errorInfo(value: unknown): { reason?: string; message?: string; sizeText?: string } {
  const root = record(value);
  if (!root) return {};
  const nested = [root, record(root.error), record(root.details), record(root.cause)].filter(
    (entry): entry is JsonRecord => entry !== undefined,
  );
  const reason = stringValue(
    ...nested.map(entry => entry.reason),
    ...nested.flatMap(entry => [entry.code, entry.errorCode, entry.errorType]),
    ...nested.map(entry => entry.type),
  );
  const message = stringValue(...nested.flatMap(entry => [entry.message, entry.errorMessage, entry.error_description, entry.error]));
  const sizes = new Set<string>();
  for (const entry of nested) {
    for (const [key, value] of Object.entries(entry)) {
      if (!/size|length|threshold|limit|count|token/i.test(key)) continue;
      if (typeof value === "number" && Number.isFinite(value)) sizes.add(`${key}=${value}`);
      else if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) sizes.add(`${key}=${value.trim()}`);
    }
  }
  return { reason, message, sizeText: sizes.size ? [...sizes].join(", ") : undefined };
}

function formatErrorBody(raw: string): { reason?: string; message: string; sizeText?: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    const reason = stringValue(raw.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0]);
    return { reason, message: raw.trim() || "Unknown error" };
  }
  const info = errorInfo(parsed);
  const rawReason = info.reason ?? stringValue(raw.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0]);
  const detail = info.message ?? (raw.trim() || "Unknown error");
  const message = `${rawReason && !detail.includes(rawReason) ? `${rawReason}: ` : ""}${detail}${info.sizeText ? ` (${info.sizeText})` : ""}`;
  return { reason: rawReason, message, sizeText: info.sizeText };
}

function setErrorDiagnostics(message: OmpAssistantMessage, reason: string | undefined): void {
  if (reasonToken(reason) !== "CONTENT_LENGTH_EXCEEDS_THRESHOLD") return;
  const diagnostic = message as OmpErrorFields;
  diagnostic.errorClassificationMessage = "context limit reached";
  diagnostic.errorId = Flag.ContextOverflow;
}

function machineHeaders(machineId: string | undefined): Record<string, string> {
  if (!machineId) return {};
  const build = `KiroIDE-${IDE_VERSION}-${machineId}`;
  return {
    "x-amzn-kiro-client-attribution": "kiro-ide",
    "user-agent": `aws-sdk-js/1.0.0 ${IDE_PLATFORM} api/codewhispererruntime#1.0.0 m/N,E ${build}`,
    "x-amz-user-agent": `aws-sdk-js/1.0.0 ${build}`,
  };
}

function jsonState(value: string): "balanced" | "incomplete" | "malformed" {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) return "malformed";
    }
  }
  return inString || stack.length ? "incomplete" : "balanced";
}

function normalizeStopReason(value: string | undefined): DoneReason | undefined {
  switch (reasonToken(value)) {
    case "END_TURN":
    case "STOP_SEQUENCE":
    case "COMPLETE":
    case "CONTENT_FILTER":
    case "CONTENT_FILTERED":
    case "GUARDRAIL_INTERVENED":
      return "stop";
    case "MAX_TOKENS":
    case "MAX_TOKEN":
    case "LENGTH":
    case "MODEL_CONTEXT_WINDOW_EXCEEDED":
      return "length";
    case "TOOL_USE":
      return "toolUse";
    default:
      return undefined;
  }
}

function payloadObject(bytes: Uint8Array): JsonRecord {
  const value: unknown = JSON.parse(textDecoder.decode(bytes));
  const object = record(value);
  if (!object) throw new Error("Kiro event payload must be an object");
  return object;
}

function credential(value: string | undefined): { token: string; region: string; profileArn?: string; authType?: "kiro_desktop" | "aws_sso_oidc"; machineId?: string } {
  if (!value?.trim()) throw new Error("No Kiro OAuth bearer token. Sign in to Kiro with AWS Builder ID or provide --api-key.");
  if (!value.trimStart().startsWith("{")) {
    if (value.trim().startsWith("ksk_")) throw new Error("Kiro ksk_ API keys require the separate API-key endpoint; sign in with AWS Builder ID for bearer transport.");
    return { token: value, region: "us-east-1" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Invalid Kiro OAuth credential envelope"); }
  const data = record(parsed);
  if (data?.version !== 1 || typeof data.token !== "string" || !data.token.trim()) throw new Error("Invalid Kiro OAuth credential envelope");
  if (data.token.trim().startsWith("ksk_")) throw new Error("Kiro ksk_ API keys cannot be used as an AWS SSO bearer token");
  const region = data.apiRegion ?? "us-east-1";
  if (typeof region !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new Error("Invalid Kiro AWS region");
  if (data.profileArn !== undefined && (typeof data.profileArn !== "string" || !/^arn:[^\s]+$/.test(data.profileArn))) throw new Error("Invalid Kiro profile ARN");
  if (data.authType !== undefined && data.authType !== "kiro_desktop" && data.authType !== "aws_sso_oidc") throw new Error("Invalid Kiro authentication type");
  if (data.machineId !== undefined && (typeof data.machineId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(data.machineId))) throw new Error("Invalid Kiro machine ID");
  return { token: data.token, region, ...(typeof data.profileArn === "string" ? { profileArn: data.profileArn } : {}),
    ...(data.authType ? { authType: data.authType } : {}), ...(typeof data.machineId === "string" ? { machineId: data.machineId } : {}) };
}

function applyUsage(message: OmpAssistantMessage, event: JsonRecord): void {
  const usage = record(event.tokenUsage);
  if (!usage) return;
  const input = Number(usage.uncachedInputTokens ?? 0);
  const read = Number(usage.cacheReadInputTokens ?? 0);
  const write = Number(usage.cacheWriteInputTokens ?? 0);
  const output = Number(usage.outputTokens ?? 0);
  if (![input, read, write, output].every(Number.isFinite)) return;
  message.usage.input = input + read + write;
  message.usage.cacheRead = read;
  message.usage.cacheWrite = write;
  message.usage.output = output;
  message.usage.totalTokens = Number(usage.totalTokens ?? input + read + write + output);
}

// Kiro reports credits but no token usage. Estimate output tokens locally with
// the model's OMP tokenizer so OMP can derive tokens/s; input and cache stay 0.
function estimateOutputTokens(message: OmpAssistantMessage, model: ModelLike): void {
  if (message.usage.output > 0) return;
  const parts = message.content.flatMap(part =>
    part.type === "text" ? [part.text]
    : part.type === "thinking" ? [part.thinking]
    : part.type === "toolCall" ? [part.name, JSON.stringify(part.arguments)]
    : []);
  if (!parts.length) return;
  const family = model.tokenizer?.replaceAll("-", "");
  const encoding = Object.values(Encoding).find(value => value.toLowerCase() === family);
  message.usage.output = countTokens(parts, encoding);
  message.usage.totalTokens = message.usage.input + message.usage.output;
}

function applyCredits(message: OmpAssistantMessage, event: JsonRecord): void {
  const nested = [event, record(event.metering), record(event.usage), record(event.meteringEvent)].filter(
    (entry): entry is JsonRecord => entry !== undefined,
  );
  let credit: number | undefined;
  for (const entry of nested) {
    const direct = entry.credits ?? entry.credit;
    if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
      credit = direct;
      break;
    }
    const unitValue = entry.unit ?? entry.unitPlural;
    const unit = typeof unitValue === "string" ? unitValue.trim().toLowerCase() : "";
    if (unit === "credit" || unit === "credits") {
      const reading = entry.usage ?? entry.amount ?? entry.value;
      if (typeof reading === "number" && Number.isFinite(reading) && reading >= 0) {
        credit = reading;
        break;
      }
    }
  }
  if (credit === undefined) return;
  message.usage.credits = {
    ...message.usage.credits,
    cost: (message.usage.credits?.cost ?? 0) + credit,
  };
}

export function streamKiro(model: ModelLike, context: OmpContext, options?: StreamOptionsLike): AssistantEventStream {
  const stream = new AssistantEventStream();
  const message: OmpAssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: emptyUsage(), stopReason: "stop", timestamp: Date.now(),
  };
  const startedAt = performance.now();

  void (async () => {
    stream.push({ type: "start", partial: message });
    try {
      const auth = credential(options?.apiKey);
      const ownProfileArn = auth.profileArn === BUILDER_ID_SERVICE_PROFILE_ARN ? undefined : auth.profileArn;
      const builderFallback = !ownProfileArn && auth.authType === "aws_sso_oidc";
      const wireClient = ownProfileArn || auth.authType === "kiro_desktop" ? "ide" : "cli";
      const profileArn = ownProfileArn ?? (builderFallback ? BUILDER_ID_SERVICE_PROFILE_ARN : undefined);
      const built = buildKiroRequest(context, model.id, options, ["eval"], wireClient);
      if (profileArn) built.payload.profileArn = profileArn;

      const body = JSON.stringify(built.payload);
      const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
      const invocationId = crypto.randomUUID();
      let response: Response;
      for (let attempt = 1; ; attempt++) {
        response = await (options?.fetch ?? fetch)(`https://runtime.${auth.region}.kiro.dev/`, {
          method: "POST", redirect: "error", signal: options?.signal,
          headers: {
            "content-type": "application/x-amz-json-1.0",
            accept: wireClient === "cli" ? "*/*" : "application/vnd.amazon.eventstream",
            authorization: `Bearer ${auth.token}`,
            "x-amz-target": TARGET,
            ...(wireClient === "ide" && profileArn ? { "x-amzn-kiro-profile-arn": profileArn } : {}),
            "x-amzn-codewhisperer-optout": "true",
            "amz-sdk-invocation-id": invocationId,
            ...(wireClient === "cli" ? {
              "user-agent": CLI_USER_AGENT,
              "x-amz-user-agent": CLI_AMZ_USER_AGENT,
              "accept-encoding": "gzip",
              "x-kiro-attempt": `${attempt};max=${MAX_SEND_ATTEMPTS}`,
              "amz-sdk-request": `attempt=${attempt}; max=${MAX_SEND_ATTEMPTS}`,
            } : {
              "user-agent": "aws-sdk-js/1.0.27 ua/2.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-1.0.0",
              "x-amz-user-agent": "aws-sdk-js/1.0.27 KiroIDE-1.0.0",
              "x-amzn-kiro-agent-mode": "vibe",
            }),
            ...machineHeaders(auth.machineId),
          },
          body,
        });
        if (response.status !== 429 || attempt === MAX_SEND_ATTEMPTS) break;
        const errorText = await response.text();
        const delayMs = retryAfterMs(response.headers.get("retry-after")) ?? THROTTLE_BASE_DELAY_MS * 2 ** (attempt - 1);
        if (QUOTA_EXHAUSTED.test(errorText) || (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs)) {
          response = new Response(errorText, { status: response.status, headers: response.headers });
          break;
        }
        await waitForRetry(delayMs, options);
      }
      if (!response.ok) {
        message.errorStatus = response.status;
        const parsed = formatErrorBody(await response.text());
        setErrorDiagnostics(message, parsed.reason);
        throw new Error(`Kiro CodeWhisperer HTTP ${response.status}: ${parsed.message.slice(0, 1000)}`);
      }
      if (!response.headers.get("content-type")?.includes("application/vnd.amazon.eventstream")) {
        throw new Error(`Kiro CodeWhisperer returned ${response.headers.get("content-type") ?? "unknown content type"} instead of eventstream`);
      }
      if (!response.body) throw new Error("Kiro CodeWhisperer response has no body");

      let textIndex: number | undefined;
      let thinkingIndex: number | undefined;
      let openTool: { id: string; name: string; index: number; raw: string } | undefined;
      let completedToolId: string | undefined;
      let stopReason: string | undefined;
      let truncated = false;
      let sawOutput = false;
      const closeText = () => {
        if (textIndex === undefined) return;
        const index = textIndex;
        textIndex = undefined;
        const block = message.content[index] as Extract<OmpContent, { type: "text" }>;
        stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
      };
      const closeThinking = () => {
        if (thinkingIndex === undefined) return;
        const index = thinkingIndex;
        thinkingIndex = undefined;
        const block = message.content[index] as Extract<OmpContent, { type: "thinking" }>;
        stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: message });
      };
      const discardTool = () => {
        if (!openTool) return;
        message.content.splice(openTool.index, 1);
        openTool = undefined;
      };
      const closeTool = (allowIncomplete = false): boolean => {
        if (!openTool) return true;
        const { index, raw } = openTool;
        if (allowIncomplete && !raw.trim()) {
          discardTool();
          return false;
        }
        let args: unknown;
        try {
          args = JSON.parse(raw || "{}");
        } catch (error) {
          if (allowIncomplete && jsonState(raw) === "incomplete") {
            discardTool();
            return false;
          }
          throw error;
        }
        const object = record(args);
        if (!object) throw new Error("Kiro tool input must be an object");
        const call = message.content[index] as Extract<OmpContent, { type: "toolCall" }>;
        call.arguments = object;
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message });
        completedToolId = openTool.id;
        openTool = undefined;
        sawOutput = true;
        return true;
      };

      for await (const frame of decodeEventStream(response.body)) {
        if (options?.signal?.aborted) throw new Error("Request was aborted");
        const kind = frame.headers[":message-type"];
        if (kind === "exception" || kind === "error") {
          const raw = frame.payload.length ? textDecoder.decode(frame.payload) : "";
          const parsed = formatErrorBody(raw);
          const name = frame.headers[":exception-type"] ?? frame.headers[":error-code"] ?? frame.headers[":event-type"] ?? "Kiro stream error";
          const reason = reasonToken(frame.headers[":error-code"])
            ?? reasonToken(frame.headers[":exception-type"])
            ?? reasonToken(parsed.reason);
          if (reason === "MODEL_TEMPORARILY_UNAVAILABLE" && (sawOutput || openTool)) {
            truncated = true;
            discardTool();
            break;
          }
          setErrorDiagnostics(message, reason);
          const detail = frame.headers[":error-message"] ?? parsed.message ?? "Unknown error";
          throw new Error(`${name}: ${reason && !detail.includes(reason) ? `${reason}: ` : ""}${detail}`);
        }
        if (kind !== "event") continue;
        const eventType = frame.headers[":event-type"];
        if (!frame.payload.length) continue;
        const ev = payloadObject(frame.payload);
        const error = record(ev.error);
        const structured = errorInfo(ev);
        const structuredReason = reasonToken(structured.reason ?? (typeof ev.error === "string" ? ev.error : undefined));
        if (structuredReason === "MODEL_TEMPORARILY_UNAVAILABLE") {
          if (sawOutput || openTool) {
            truncated = true;
            discardTool();
            break;
          }
          throw new Error(`Kiro stream error: ${structuredReason}: ${structured.message ?? "Unknown error"}`);
        }
        setErrorDiagnostics(message, structuredReason);
        if (typeof error?.message === "string") {
          const detail = `${structuredReason && !error.message.includes(structuredReason) ? `${structuredReason}: ` : ""}${error.message}${structured.sizeText ? ` (${structured.sizeText})` : ""}`;
          throw new Error(`Kiro stream error: ${detail}`);
        }
        if (eventType === "assistantResponseEvent") {
          closeTool();
          closeThinking();
          if (typeof ev.content !== "string" || !ev.content) continue;
          sawOutput = true;
          if (textIndex === undefined) {
            textIndex = message.content.length;
            message.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: textIndex, partial: message });
          }
          const block = message.content[textIndex] as Extract<OmpContent, { type: "text" }>;
          block.text += ev.content;
          stream.push({ type: "text_delta", contentIndex: textIndex, delta: ev.content, partial: message });
        } else if (eventType === "reasoningContentEvent") {
          closeTool();
          closeText();
          if (ev.text !== undefined && typeof ev.text !== "string") throw new Error("Kiro reasoning text must be a string");
          if (ev.signature !== undefined && typeof ev.signature !== "string") throw new Error("Kiro reasoning signature must be a string");
          if (ev.redactedContent !== undefined && typeof ev.redactedContent !== "string") throw new Error("Kiro reasoning redactedContent must be a string");
          if (ev.text || ev.signature || ev.redactedContent) {
            sawOutput = true;
            if (thinkingIndex === undefined) {
              thinkingIndex = message.content.length;
              message.content.push({ type: "thinking", thinking: "" });
              stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: message });
            }
            const block = message.content[thinkingIndex] as Extract<OmpContent, { type: "thinking" }>;
            if (typeof ev.text === "string" && ev.text) {
              block.thinking += ev.text;
              stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: ev.text, partial: message });
            }
            if (typeof ev.signature === "string") block.thinkingSignature = `kiro:signature:${ev.signature}`;
            else if (typeof ev.redactedContent === "string") block.thinkingSignature = `kiro:redactedContent:${ev.redactedContent}`;
          }
        } else if (eventType === "toolUseEvent") {
          closeText();
          closeThinking();
          const id = typeof ev.toolUseId === "string" ? ev.toolUseId : openTool?.id;
          if (!id) throw new Error("Kiro tool event missing id");
          if (!openTool && completedToolId === id && ev.input === undefined && ev.stop !== undefined) continue;
          if (openTool && openTool.id !== id) closeTool();
          if (!openTool) {
            if (typeof ev.name !== "string" || !ev.name) throw new Error("Kiro tool event missing name");
            const name = built.registry.restore(ev.name);
            const index = message.content.length;
            message.content.push({ type: "toolCall", id, name, arguments: {} });
            openTool = { id, name, index, raw: "" };
            stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
          }
          if (ev.input !== undefined && ev.input !== null) {
            const delta = typeof ev.input === "string" ? ev.input : JSON.stringify(ev.input);
            openTool.raw += delta;
            stream.push({ type: "toolcall_delta", contentIndex: openTool.index, delta, partial: message });
            if (typeof ev.input !== "string") closeTool();
          }
          if (ev.stop !== undefined && ev.stop !== false && openTool) closeTool();
        } else if (eventType === "messageMetadataEvent" || eventType === "initial-response") {
          if (typeof ev.conversationId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(ev.conversationId)) {
            message.responseId = ev.conversationId;
          }
        } else if (eventType === "metadataEvent") {
          if (typeof ev.stopReason === "string") stopReason = ev.stopReason;
          else if (typeof ev.stop_reason === "string") stopReason = ev.stop_reason;
          applyUsage(message, ev);
          applyCredits(message, ev);
        } else if (eventType === "meteringEvent" || eventType === "metering" || eventType === "creditEvent" || eventType === "usageEvent") {
          applyCredits(message, ev);
        } else if (eventType === "invalidStateEvent" || eventType === "error") {
          throw new Error(typeof ev.message === "string" ? ev.message : `Kiro ${eventType}`);
        }
      }
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (openTool) {
        if (!closeTool(true)) truncated = true;
      }
      closeText();
      closeThinking();
      let hasThinking = false;
      let hasToolCall = false;
      let hasAnswer = false;
      for (const part of message.content) {
        if (part.type === "thinking") hasThinking = true;
        else if (part.type === "toolCall") { hasToolCall = true; hasAnswer = true; }
        else if (part.type === "text" && part.text.trim()) hasAnswer = true;
      }
      if (hasThinking && !hasAnswer) {
        throw new Error("Kiro completed without an answer or tool call");
      }
      message.responseId ??= built.payload.conversationState.conversationId;
      const reason: DoneReason = hasToolCall ? "toolUse" : truncated ? "length" : normalizeStopReason(stopReason) ?? "stop";
      message.stopReason = reason;
      estimateOutputTokens(message, model);
      message.duration = performance.now() - startedAt;
      stream.push({ type: "done", reason, message });
    } catch (error) {
      message.stopReason = options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      message.duration = performance.now() - startedAt;
      stream.push({ type: "error", reason: message.stopReason, error: message });
    }
  })();
  return stream;
}
