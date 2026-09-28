import { decodeEventStream } from "./eventstream";
import { buildKiroRequest } from "./messages";
import type { JsonRecord, ModelLike, OmpAssistantEvent, OmpAssistantMessage, OmpContext, OmpContent, OmpUsage, StreamOptionsLike } from "./types";

const TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const BUILDER_ID_SERVICE_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
const textDecoder = new TextDecoder();

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

function payloadObject(bytes: Uint8Array): JsonRecord {
  const value: unknown = JSON.parse(textDecoder.decode(bytes));
  const object = record(value);
  if (!object) throw new Error("Kiro event payload must be an object");
  return object;
}

function credential(value: string | undefined): { token: string; region: string; profileArn?: string; authType?: "kiro_desktop" | "aws_sso_oidc" } {
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
  return { token: data.token, region, ...(typeof data.profileArn === "string" ? { profileArn: data.profileArn } : {}),
    ...(data.authType ? { authType: data.authType } : {}) };
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

export function streamKiro(model: ModelLike, context: OmpContext, options?: StreamOptionsLike): AssistantEventStream {
  const stream = new AssistantEventStream();
  const message: OmpAssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: emptyUsage(), stopReason: "stop", timestamp: Date.now(),
  };

  void (async () => {
    stream.push({ type: "start", partial: message });
    try {
      const auth = credential(options?.apiKey);
      const ownProfileArn = auth.profileArn === BUILDER_ID_SERVICE_PROFILE_ARN ? undefined : auth.profileArn;
      const builderFallback = !ownProfileArn && auth.authType === "aws_sso_oidc";
      const wireClient = ownProfileArn ? "ide" : "cli";
      const profileArn = ownProfileArn ?? (builderFallback ? BUILDER_ID_SERVICE_PROFILE_ARN : undefined);
      const built = buildKiroRequest(context, model.id, options, ["eval"], wireClient);
      if (profileArn) built.payload.profileArn = profileArn;
      const cliAgent = wireClient === "cli"
        ? `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"} lang/rust/1.92.0 m/F app/AmazonQ-For-CLI`
        : undefined;

      const response = await fetch(`https://runtime.${auth.region}.kiro.dev/`, {
        method: "POST", redirect: "error", signal: options?.signal,
        headers: {
          "content-type": "application/x-amz-json-1.0",
          accept: wireClient === "cli" ? "*/*" : "application/vnd.amazon.eventstream",
          authorization: `Bearer ${auth.token}`,
          "x-amz-target": TARGET,
          ...(profileArn ? { "x-amzn-kiro-profile-arn": profileArn } : {}),
          "x-amzn-codewhisperer-optout": "true",
          "amz-sdk-invocation-id": crypto.randomUUID(),
          ...(cliAgent ? {
            "user-agent": cliAgent.replace(" m/F", " md/appVersion-2.14.2 m/F"),
            "x-amz-user-agent": cliAgent,
            "amz-sdk-request": "attempt=1; max=3",
          } : {
            "user-agent": "aws-sdk-js/1.0.27 ua/2.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-1.0.0",
            "x-amz-user-agent": "aws-sdk-js/1.0.27 KiroIDE-1.0.0",
            "x-amzn-kiro-agent-mode": "vibe",
          }),
        },
        body: JSON.stringify(built.payload),
      });
      if (!response.ok) {
        message.errorStatus = response.status;
        throw new Error(`Kiro CodeWhisperer HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
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
      const closeTool = () => {
        if (!openTool) return;
        const { index, raw } = openTool;
        const args: unknown = JSON.parse(raw || "{}");
        const object = record(args);
        if (!object) throw new Error("Kiro tool input must be an object");
        const call = message.content[index] as Extract<OmpContent, { type: "toolCall" }>;
        call.arguments = object;
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message });
        completedToolId = openTool.id;
        openTool = undefined;
      };

      for await (const frame of decodeEventStream(response.body)) {
        if (options?.signal?.aborted) throw new Error("Request was aborted");
        const kind = frame.headers[":message-type"];
        if (kind === "exception" || kind === "error") {
          let detail: string | undefined;
          if (frame.payload.length) {
            const raw = textDecoder.decode(frame.payload);
            try {
              const body = record(JSON.parse(raw));
              detail = typeof body?.message === "string" ? body.message : raw;
            } catch { detail = raw; }
          }
          const name = frame.headers[":exception-type"] ?? frame.headers[":error-code"] ?? frame.headers[":event-type"] ?? "Kiro stream error";
          throw new Error(`${name}: ${frame.headers[":error-message"] ?? detail ?? "Unknown error"}`);
        }
        if (kind !== "event") continue;
        const eventType = frame.headers[":event-type"];
        if (!frame.payload.length) continue;
        const ev = payloadObject(frame.payload);
        const error = record(ev.error);
        if (typeof error?.message === "string") throw new Error(`Kiro stream error: ${error.message}`);
        if (eventType === "assistantResponseEvent") {
          closeTool();
          closeThinking();
          if (typeof ev.content !== "string" || !ev.content) continue;
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
            else if (ev.stop === undefined) {
              try { if (record(JSON.parse(openTool.raw))) closeTool(); } catch { /* input may arrive in further chunks */ }
            }
          }
          if (ev.stop !== undefined && ev.stop !== false && openTool) closeTool();
        } else if (eventType === "messageMetadataEvent" || eventType === "initial-response") {
          if (typeof ev.conversationId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(ev.conversationId)) {
            message.responseId = ev.conversationId;
          }
        } else if (eventType === "metadataEvent") {
          if (typeof ev.stopReason === "string") stopReason = ev.stopReason;
          applyUsage(message, ev);
        } else if (eventType === "invalidStateEvent" || eventType === "error") {
          throw new Error(typeof ev.message === "string" ? ev.message : `Kiro ${eventType}`);
        }
      }
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      closeTool();
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
      const reason = hasToolCall ? "toolUse" : stopReason === "MAX_TOKENS" ? "length" : "stop";
      message.stopReason = reason;
      stream.push({ type: "done", reason, message });
    } catch (error) {
      message.stopReason = options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: message.stopReason, error: message });
    }
  })();
  return stream;
}
