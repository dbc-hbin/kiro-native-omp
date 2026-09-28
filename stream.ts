import { decodeEventStream } from "./eventstream";
import { buildKiroRequest } from "./messages";
import type { JsonRecord, ModelLike, OmpAssistantEvent, OmpAssistantMessage, OmpContext, OmpContent, OmpUsage, StreamOptionsLike } from "./types";

const ENDPOINT = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
const TARGET = "AmazonCodeWhispererService.GenerateAssistantResponse";

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
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const object = record(value);
  if (!object) throw new Error("Kiro event payload must be an object");
  return object;
}

function credential(value: string | undefined): { token: string; region: string; profileArn?: string } {
  if (!value?.trim()) throw new Error("No Kiro OAuth bearer token. Sign in to Kiro with AWS Builder ID or provide --api-key.");
  if (!value.trimStart().startsWith("{")) {
    if (value.startsWith("ksk_")) throw new Error("Kiro ksk_ API keys require the separate API-key endpoint; sign in with AWS Builder ID for bearer transport.");
    return { token: value, region: "us-east-1" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Invalid Kiro OAuth credential envelope"); }
  const data = record(parsed);
  if (data?.version !== 1 || typeof data.token !== "string" || !data.token.trim()) throw new Error("Invalid Kiro OAuth credential envelope");
  if (data.token.startsWith("ksk_")) throw new Error("Kiro ksk_ API keys cannot be used as an AWS SSO bearer token");
  const region = data.apiRegion ?? "us-east-1";
  if (typeof region !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new Error("Invalid Kiro AWS region");
  if (data.profileArn !== undefined && (typeof data.profileArn !== "string" || !/^arn:[^\s]+$/.test(data.profileArn))) throw new Error("Invalid Kiro profile ARN");
  return { token: data.token, region, ...(typeof data.profileArn === "string" ? { profileArn: data.profileArn } : {}) };
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
      const built = buildKiroRequest(context, model.id, options, ["eval"]);
      if (auth.profileArn) built.payload.profileArn = auth.profileArn;

      const response = await fetch(auth.region === "us-east-1" ? ENDPOINT : `https://codewhisperer.${auth.region}.amazonaws.com/generateAssistantResponse`, {
        method: "POST", redirect: "error", signal: options?.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/vnd.amazon.eventstream",
          authorization: `Bearer ${auth.token}`,
          "amzn-X-amz-target": TARGET,
          ...(auth.profileArn ? { "x-amzn-codewhisperer-proflearn": auth.profileArn } : {}),
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
            const raw = new TextDecoder().decode(frame.payload);
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
          if (typeof ev.content !== "string" || !ev.content) continue;
          if (textIndex === undefined) {
            textIndex = message.content.length;
            message.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: textIndex, partial: message });
          }
          const block = message.content[textIndex] as Extract<OmpContent, { type: "text" }>;
          block.text += ev.content;
          stream.push({ type: "text_delta", contentIndex: textIndex, delta: ev.content, partial: message });
        } else if (eventType === "toolUseEvent") {
          closeText();
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
        } else if (eventType === "messageMetadataEvent") {
          if (typeof ev.conversationId === "string") message.responseId = ev.conversationId;
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
      const reason = message.content.some(part => part.type === "toolCall") ? "toolUse" : stopReason === "MAX_TOKENS" ? "length" : "stop";
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
