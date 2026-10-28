// Drives the extension through OMP's real custom-API dispatch (pi-ai
// `registerCustomApi` + `streamSimple`), the same path a registered provider
// takes at runtime: loop guard, in-flight limiter, and OMP's own types. Only the
// Kiro HTTP endpoint is replaced, through the `fetch` option OMP forwards.
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  Effort,
  type Model,
  registerCustomApi,
  streamSimple,
  type Tool,
} from "@oh-my-pi/pi-ai";
import { encodeEventFrame, framesToChunkedResponse } from "./eventstream";
import { streamKiro } from "./stream";
import type { KiroRequestPayload, OmpContext, StreamOptionsLike } from "./types";
import { classifyMessage, Flag, is, retriable } from "@oh-my-pi/pi-ai/error";

const API = "kiro-codewhisperer-stream";
// OMP accepts any async iterable with `result()` here (the extension ships no
// pi-ai dependency); the cast is the extension's structural stand-in, which the
// assertions below exercise at runtime.
registerCustomApi(API, (model, context, options) =>
  streamKiro(model, context as OmpContext, options as StreamOptionsLike) as unknown as AssistantMessageEventStream);

const model = {
  id: "claude-opus-5.5",
  name: "Claude Opus 5.5",
  api: API,
  provider: "kiro-native",
  baseUrl: "https://runtime.us-east-1.kiro.dev/",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 32_000,
} as Model;

const bash: Tool = {
  name: "bash",
  description: "Run a shell command",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
} as Tool;

function kiroEndpoint(responses: Array<Uint8Array[]>) {
  const bodies: KiroRequestPayload[] = [];
  const fetchImpl = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const frames = responses.shift();
    if (!frames) throw new Error("unexpected extra Kiro request");
    return framesToChunkedResponse(frames);
  }, { preconnect: globalThis.fetch.preconnect });
  return { bodies, fetch: fetchImpl };
}

test("an OMP tool turn round-trips through streamSimple with the calls OMP executes", async () => {
  const endpoint = kiroEndpoint([
    [
      encodeEventFrame("assistantResponseEvent", { content: "Running it." }),
      encodeEventFrame("toolUseEvent", { toolUseId: "tooluse_1", name: "bash", input: '{"command":"echo hi"}', stop: true }),
    ],
    [encodeEventFrame("assistantResponseEvent", { content: "It printed hi." })],
  ]);
  const context: Context = {
    systemPrompt: ["You are terse."],
    tools: [bash],
    messages: [{ role: "user", content: "run echo hi", timestamp: 1 }],
  };
  const options = { apiKey: "access-token", reasoning: Effort.High, fetch: endpoint.fetch, cwd: tmpdir() };

  const first = await streamSimple(model, context, options).result();
  expect(first.stopReason).toBe("toolUse");
  expect(first.content).toEqual([
    { type: "text", text: "Running it." },
    { type: "toolCall", id: "tooluse_1", name: "bash", arguments: { command: "echo hi" } },
  ]);
  expect(endpoint.bodies[0].additionalModelRequestFields).toEqual({
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
  });

  context.messages.push(first, {
    role: "toolResult", toolCallId: "tooluse_1", toolName: "bash",
    content: [{ type: "text", text: "hi\n" }], isError: false, timestamp: 3,
  });
  const second = await streamSimple(model, context, options).result();
  expect(second.stopReason).toBe("stop");
  expect(second.content).toEqual([{ type: "text", text: "It printed hi." }]);
  const state = endpoint.bodies[1].conversationState;
  expect(state.conversationId).toBe(endpoint.bodies[0].conversationState.conversationId);
  expect(state.currentMessage.userInputMessage.content).toBe("");
  expect(state.currentMessage.userInputMessage.userInputMessageContext?.envState?.currentWorkingDirectory).toBe(options.cwd);
  expect(endpoint.bodies[1].conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults)
    .toEqual([{ toolUseId: "tooluse_1", status: "success", content: [{ text: "hi\n" }] }]);
});

test("a session resumed after an aborted tool call sends a paired, valid history", async () => {
  const endpoint = kiroEndpoint([[encodeEventFrame("assistantResponseEvent", { content: "OK" })]]);
  const aborted: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "tooluse_cut", name: "bash", arguments: { command: "sleep 99" } }],
    api: API, provider: "kiro-native", model: model.id, stopReason: "aborted", errorMessage: "Request was aborted",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 2,
  };
  const context: Context = {
    tools: [bash],
    messages: [
      { role: "user", content: "wait a bit", timestamp: 1 },
      aborted,
      { role: "user", content: "never mind, say OK", timestamp: 3 },
    ],
  };
  const result = await streamSimple(model, context, { apiKey: "access-token", fetch: endpoint.fetch }).result();
  expect(result.stopReason).toBe("stop");
  const { history = [], currentMessage } = endpoint.bodies[0].conversationState;
  expect(history[1].assistantResponseMessage?.toolUses?.map(use => use.toolUseId)).toEqual(["tooluse_cut"]);
  expect(currentMessage.userInputMessage.content).toBe("never mind, say OK");
  expect(currentMessage.userInputMessage.userInputMessageContext?.toolResults)
    .toEqual([{ toolUseId: "tooluse_cut", status: "error", content: [{ text: "aborted" }] }]);
});

test("a forced tool choice from OMP reaches Kiro as a narrowed catalog, not an error", async () => {
  const endpoint = kiroEndpoint([[
    encodeEventFrame("toolUseEvent", { toolUseId: "tooluse_y", name: "yield", input: '{"result":"done"}', stop: true }),
  ]]);
  const yieldTool = { name: "yield", description: "Finish", parameters: { type: "object", properties: {} } } as Tool;
  const context: Context = { tools: [bash, yieldTool], messages: [{ role: "user", content: "finish", timestamp: 1 }] };
  const result = await streamSimple(model, context, {
    apiKey: "access-token", fetch: endpoint.fetch, toolChoice: { type: "tool", name: "yield" },
  }).result();
  expect(result.stopReason).toBe("toolUse");
  expect(endpoint.bodies[0].conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools
    ?.map(tool => tool.toolSpecification.name)).toEqual(["yield"]);
});

test("Kiro rejecting the model surfaces as an OMP error result with the HTTP status", async () => {
  const fetchImpl = Object.assign(async () => new Response(
    JSON.stringify({ __type: "com.amazon.kiro.runtimeservice#ValidationException", reason: "INVALID_MODEL_ID" }),
    { status: 400 },
  ), { preconnect: globalThis.fetch.preconnect });
  const result = await streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
    apiKey: "access-token", fetch: fetchImpl,
  }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorStatus).toBe(400);
  expect(result.errorMessage).toContain("INVALID_MODEL_ID");
});

test("thinking-only Kiro completions reach OMP as retryable empty responses", async () => {
  for (const reasoning of [{ signature: "opaque-proof" }, { text: "Still reasoning" }]) {
    const endpoint = kiroEndpoint([[
      encodeEventFrame("reasoningContentEvent", reasoning),
      encodeEventFrame("metadataEvent", { stopReason: "END_TURN" }),
    ]]);
    const result = await streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
      apiKey: "access-token", fetch: endpoint.fetch,
    }).result();
    expect(result.stopReason).toBe("error");
    expect(result.content.every(part => part.type === "thinking")).toBe(true);
    const errorId = classifyMessage(result);
    expect(is(errorId, Flag.EmptyResponse)).toBe(true);
    expect(retriable(errorId)).toBe(true);
    expect(endpoint.bodies).toHaveLength(1);
  }
});

test("explicitly filtered Kiro responses without an answer preserve the reason and are not retried", async () => {
  for (const stopReason of ["CONTENT_FILTER", " content-filtered ", "GUARDRAIL_INTERVENED"]) {
    for (const precedingFrames of [
      [],
      [encodeEventFrame("reasoningContentEvent", { text: "Still reasoning" })],
      [encodeEventFrame("assistantResponseEvent", { content: " " })],
    ]) {
      const endpoint = kiroEndpoint([[
        ...precedingFrames,
        encodeEventFrame("metadataEvent", { stopReason }),
      ]]);
      const result = await streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
        apiKey: "access-token", fetch: endpoint.fetch,
      }).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(stopReason.trim().toUpperCase().replaceAll("-", "_"));
      const errorId = classifyMessage(result);
      expect(is(errorId, Flag.ContentBlocked)).toBe(true);
      expect(is(errorId, Flag.EmptyResponse)).toBe(false);
      expect(retriable(errorId)).toBe(false);
      expect(endpoint.bodies).toHaveLength(1);
    }
  }
});

const throttled = (headers: Record<string, string> = {}, reason = "USER_REQUEST_RATE_EXCEEDED") => new Response(
  JSON.stringify({ __type: "com.amazon.kiro.runtimeservice#ThrottlingException", message: "Too many requests, please wait before trying again.", reason }),
  { status: 429, headers },
);

function scriptedFetch(responses: Array<() => Response>) {
  const attempts: string[] = [];
  const invocationIds: Array<string | null> = [];
  const fetchImpl = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    attempts.push(headers.get("amz-sdk-request") ?? "");
    invocationIds.push(headers.get("amz-sdk-invocation-id"));
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra Kiro request");
    return next();
  }, { preconnect: globalThis.fetch.preconnect });
  return { attempts, invocationIds, fetch: fetchImpl };
}

test("a transient Kiro rate limit is retried inside the provider and the turn completes", async () => {
  const endpoint = scriptedFetch([
    () => throttled({ "retry-after": "3" }),
    () => throttled(),
    () => framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "OK" })]),
    () => framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "Next" })]),
  ]);
  const waits: number[] = [];
  const result = await streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
    apiKey: "access-token", fetch: endpoint.fetch,
    providerRetryWait: async delayMs => { waits.push(delayMs); },
  }).result();
  expect(result.stopReason).toBe("stop");
  expect(result.content).toEqual([{ type: "text", text: "OK" }]);
  // Server Retry-After wins; otherwise exponential backoff from 2s.
  expect(waits).toEqual([3_000, 4_000]);
  expect(endpoint.attempts).toEqual(["attempt=1; max=3", "attempt=2; max=3", "attempt=3; max=3"]);
  const invocationId = endpoint.invocationIds[0];
  expect(invocationId).toEqual(expect.any(String));
  expect(endpoint.invocationIds).toEqual([invocationId, invocationId, invocationId]);

  const next = await streamSimple(model, { messages: [{ role: "user", content: "next", timestamp: 2 }] }, {
    apiKey: "access-token", fetch: endpoint.fetch,
  }).result();
  expect(next.content).toEqual([{ type: "text", text: "Next" }]);
  expect(endpoint.invocationIds[3]).not.toBe(invocationId);
});

test("a rate limit that outlasts the retry budget reaches OMP as a 429 error", async () => {
  const endpoint = scriptedFetch([() => throttled(), () => throttled(), () => throttled()]);
  const result = await streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
    apiKey: "access-token", fetch: endpoint.fetch, providerRetryWait: async () => {},
  }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorStatus).toBe(429);
  expect(result.errorMessage).toContain("USER_REQUEST_RATE_EXCEEDED");
  expect(endpoint.attempts).toHaveLength(3);
});

test("an exhausted monthly quota and a wait beyond OMP's cap are not retried", async () => {
  for (const [response, options] of [
    [() => throttled({}, "MONTHLY_REQUEST_COUNT"), {}],
    [() => throttled({ "retry-after": "120" }), { maxRetryDelayMs: 60_000 }],
  ] as const) {
    const endpoint = scriptedFetch([response]);
    let waited = false;
    const result = await streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
      apiKey: "access-token", fetch: endpoint.fetch, ...options,
      providerRetryWait: async () => { waited = true; },
    }).result();
    expect(result.errorStatus).toBe(429);
    expect(waited).toBe(false);
    expect(endpoint.attempts).toHaveLength(1);
  }
});
