// Drives the extension through OMP's real custom-API dispatch (pi-ai
// `registerCustomApi` + `streamSimple`), the same path a registered provider
// takes at runtime: loop guard, in-flight limiter, and OMP's own types. Only the
// Kiro HTTP endpoint is replaced, through the `fetch` option OMP forwards.
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
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
import kiroNativeExtension from "./index";
import type { kiroOAuthProvider } from "./oauth";
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

async function accountFixture(ids: string[]) {
  type Api = Parameters<typeof kiroNativeExtension>[0];
  const handlers = new Map<Parameters<Api["on"]>[0], Parameters<Api["on"]>[1]>();
  kiroNativeExtension({
    setLabel() {},
    logger: { debug() {} },
    on(event, handler) { handlers.set(event, handler); },
    registerProvider(id, config) {
      const { oauth } = config as { oauth: ReturnType<typeof kiroOAuthProvider> };
      registerOAuthProvider({
        id, ...oauth,
        async login() { throw new Error("Interactive login is not part of the routing fixture"); },
      });
    },
  });
  const store = new SqliteAuthCredentialStore(new Database(":memory:"));
  for (const id of ids) {
    await store.upsertAuthCredential(model.provider, {
      type: "oauth", access: `token-${id}`, refresh: `refresh-${id}`,
      expires: Date.now() + 3_600_000, accountId: id,
    });
  }
  const auth = new AuthStorage(store);
  await auth.credentials.reload();
  const emit = (event: Parameters<Api["on"]>[0], session: string, storage = auth, selectedModel = model) =>
    handlers.get(event)!({ type: event }, {
      model: selectedModel,
      modelRegistry: { authStorage: storage },
      sessionManager: { getSessionId: () => session },
    });
  const token = async (session: string, storage = auth) =>
    JSON.parse((await storage.keys.get(model.provider, session))!).token as string;
  return { store, auth, emit, token };
}

test("new Kiro sessions rotate accounts while turns, switches and resumes retain their bearer", async () => {
  const fixture = await accountFixture(["A", "B", "C"]);
  try {
    const observed: string[] = [];
    for (const session of ["one", "two", "one", "three", "two", "four"]) {
      await fixture.emit("session_start", session);
      await fixture.emit("input", session);
      const apiKey = await fixture.auth.keys.get(model.provider, session);
      const fetchImpl = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
        observed.push(new Headers(init?.headers).get("authorization")!);
        return framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "OK" })]);
      }, { preconnect: globalThis.fetch.preconnect });
      const result = await streamSimple(model, {
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      }, { apiKey, fetch: fetchImpl }).result();
      expect(result.stopReason).toBe("stop");
    }
    expect(observed).toEqual(["Bearer token-A", "Bearer token-B", "Bearer token-A",
      "Bearer token-C", "Bearer token-B", "Bearer token-A"]);

    const resumed = new AuthStorage(fixture.store);
    await resumed.credentials.reload();
    await fixture.emit("session_switch", "two", resumed);
    expect(await fixture.token("two", resumed)).toBe("token-B");
    const accountC = resumed.oauth.accounts(model.provider).find(account => account.accountId === "C")!;
    resumed.sessions.pin(model.provider, "manual", accountC.credentialId);
    await fixture.emit("session_start", "manual", resumed);
    expect(await fixture.token("manual", resumed)).toBe("token-C");
    resumed.sessions.inherit("two", "branch");
    await fixture.emit("session_branch", "branch", resumed);
    expect(await fixture.token("branch", resumed)).toBe("token-B");
  } finally {
    fixture.store.close();
  }
});

test("overlapping lifecycle events allocate a session only once", async () => {
  const fixture = await accountFixture(["A", "B", "C"]);
  try {
    await Promise.all([
      fixture.emit("session_start", "one"),
      fixture.emit("input", "one"),
      fixture.emit("session_start", "two"),
    ]);
    expect(await fixture.token("one")).toBe("token-A");
    expect(await fixture.token("two")).toBe("token-B");
    await fixture.emit("session_branch", "three");
    expect(await fixture.token("three")).toBe("token-C");
  } finally {
    fixture.store.close();
  }
});

test("model cycling authenticates the preassigned account before changing the selected provider", async () => {
  const fixture = await accountFixture(["A", "B", "C"]);
  try {
    const selectedModel = { ...model, provider: "other" };
    const observed: string[] = [];
    for (const session of ["one", "two", "three", "four"]) {
      await fixture.emit("session_start", session, fixture.auth, selectedModel);
      // OMP cycle_model resolves the candidate key before updating ctx.model.
      observed.push(await fixture.token(session));
      await fixture.emit("input", session);
      expect(await fixture.token(session)).toBe(observed.at(-1)!);
    }
    expect(observed).toEqual(["token-A", "token-B", "token-C", "token-A"]);
  } finally {
    fixture.store.close();
  }
});

test("late login and model switching bind on input without consuming accounts for other providers", async () => {
  const fixture = await accountFixture([]);
  try {
    await fixture.emit("session_start", "late");
    await fixture.auth.credentials.upsert(model.provider, {
      type: "oauth", access: "token-A", refresh: "refresh-A",
      expires: Date.now() + 3_600_000, accountId: "A",
    });
    await fixture.auth.credentials.upsert(model.provider, {
      type: "oauth", access: "token-B", refresh: "refresh-B",
      expires: Date.now() + 3_600_000, accountId: "B",
    });
    await fixture.emit("input", "other", fixture.auth, { ...model, provider: "other" });
    await fixture.emit("input", "late");
    expect(await fixture.token("late")).toBe("token-A");
    await fixture.emit("input", "other");
    expect(await fixture.token("other")).toBe("token-B");

    fixture.auth.keys.setRuntime(model.provider, "explicit-key");
    await fixture.emit("input", "override");
    expect(await fixture.auth.keys.get(model.provider, "override")).toBe("explicit-key");
    expect(fixture.auth.oauth.accounts(model.provider, "override").some(account => account.active)).toBe(false);
  } finally {
    fixture.store.close();
  }
});

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

test("explicitly filtered Kiro responses without an answer preserve the reason and stay retryable", async () => {
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
      expect(is(errorId, Flag.ContentBlocked)).toBe(false);
      expect(is(errorId, Flag.EmptyResponse)).toBe(true);
      expect(retriable(errorId)).toBe(true);
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

test("monthly quota exhaustion rotates the bearer and retains the replacement account", async () => {
  for (const exhausted of [
    () => throttled({}, "MONTHLY_REQUEST_COUNT"),
    () => framesToChunkedResponse([encodeEventFrame("throttlingException", {
      reason: "MONTHLY_REQUEST_COUNT", message: "Too many requests, please wait before trying again.",
    }, "exception")]),
  ]) {
    const fixture = await accountFixture(["A", "B"]);
    try {
      await fixture.emit("session_start", "quota");
      const sent: string[] = [];
      const bodies: unknown[] = [];
      const fetchImpl = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const bearer = new Headers(init?.headers).get("authorization")!;
        sent.push(bearer);
        bodies.push(JSON.parse(String(init?.body)));
        return bearer === "Bearer token-A" ? exhausted()
          : framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "OK" })]);
      }, { preconnect: globalThis.fetch.preconnect });
      const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
      const options = {
        apiKey: fixture.auth.keys.resolver(model.provider, { sessionId: "quota", modelId: model.id }),
        fetch: fetchImpl,
        providerRetryWait: async () => { throw new Error("Monthly quota must rotate without throttle waits"); },
      };
      const result = await streamSimple(model, context, options).result();
      expect(result.stopReason).toBe("stop");
      expect(result.content).toEqual([{ type: "text", text: "OK" }]);
      expect(sent).toEqual(["Bearer token-A", "Bearer token-B"]);
      const first = bodies[0] as KiroRequestPayload;
      const second = bodies[1] as KiroRequestPayload;
      expect(second.conversationState.currentMessage).toEqual(first.conversationState.currentMessage);
      expect(await fixture.token("quota")).toBe("token-B");
      await fixture.emit("input", "quota");
      expect((await streamSimple(model, context, options).result()).stopReason).toBe("stop");
      expect(sent).toEqual(["Bearer token-A", "Bearer token-B", "Bearer token-B"]);
      expect(fixture.auth.oauth.accounts(model.provider).map(account => account.accountId)).toEqual(["A", "B"]);
    } finally {
      fixture.store.close();
    }
  }
});

test("exhausting every OAuth account stops after trying each without disabling credentials", async () => {
  const fixture = await accountFixture(["A", "B"]);
  try {
    await fixture.emit("session_start", "all-spent");
    const sent: string[] = [];
    const fetchImpl = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("authorization")!);
      return throttled({}, "MONTHLY_REQUEST_COUNT");
    }, { preconnect: globalThis.fetch.preconnect });
    const result = await streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
      apiKey: fixture.auth.keys.resolver(model.provider, { sessionId: "all-spent", modelId: model.id }),
      fetch: fetchImpl,
      providerRetryWait: async () => { throw new Error("Monthly quota must not wait"); },
    }).result();
    expect(result.stopReason).toBe("error");
    expect(is(classifyMessage(result), Flag.UsageLimit)).toBe(true);
    expect(result.errorMessage).toContain("MONTHLY_REQUEST_COUNT");
    expect(sent).toEqual(["Bearer token-A", "Bearer token-B"]);
    expect(fixture.auth.oauth.accounts(model.provider).map(account => account.accountId)).toEqual(["A", "B"]);
  } finally {
    fixture.store.close();
  }
});

test("transient request throttling does not rotate to another OAuth account", async () => {
  const fixture = await accountFixture(["A", "B"]);
  try {
    await fixture.emit("session_start", "throttle");
    const sent: string[] = [];
    const fetchImpl = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("authorization")!);
      return throttled();
    }, { preconnect: globalThis.fetch.preconnect });
    const result = await streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
      apiKey: fixture.auth.keys.resolver(model.provider, { sessionId: "throttle", modelId: model.id }),
      fetch: fetchImpl, providerRetryWait: async () => {},
    }).result();
    expect(result.stopReason).toBe("error");
    expect(is(classifyMessage(result), Flag.UsageLimit)).toBe(false);
    expect(sent).toEqual(["Bearer token-A", "Bearer token-A", "Bearer token-A"]);
    expect(await fixture.token("throttle")).toBe("token-A");
  } finally {
    fixture.store.close();
  }
});
