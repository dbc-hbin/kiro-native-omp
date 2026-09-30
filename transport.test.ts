import { afterEach, expect, spyOn, test } from "bun:test";
import { encodeEventFrame, framesToChunkedResponse } from "./eventstream";
import { buildKiroRequest } from "./messages";
import { kiroOAuthProvider } from "./oauth";
import { streamKiro } from "./stream";
import type { OmpAssistantEvent, OmpContext, StreamOptionsLike } from "./types";

const model = { id: "claude-haiku-4-5", provider: "kiro-native", api: "kiro-codewhisperer-stream" };
const context: OmpContext = { systemPrompt: "Be concise", messages: [{ role: "user", content: "Hello" }] };
let fetchSpy: { mockRestore(): void } | undefined;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; });

async function collect(ctx: OmpContext = context, options: StreamOptionsLike = { apiKey: "plain-access" }, selectedModel = model) {
  const stream = streamKiro(selectedModel, ctx, options);
  const events: OmpAssistantEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

test("Builder ID sends the selected model, request-scoped service profile, and Kiro CLI wire without leaking credentials", async () => {
  const name = "mcp/tool with spaces";
  const ctx: OmpContext = {
    systemPrompt: "System instruction",
    tools: [{ name, description: "describe", parameters: { type: "object", properties: { x: { type: "string" } } } }],
    messages: [
      { role: "user", content: "call it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call/a", name, arguments: { x: "yes" } }] },
      { role: "toolResult", toolCallId: "call/a", toolName: name, content: [{ type: "text", text: "done" }], isError: false },
    ],
  };
  const auth = kiroOAuthProvider().getApiKey({
    access: "secret-access", refresh: "secret-refresh", expires: 0,
    kiro: { apiRegion: "eu-west-1", authType: "aws_sso_oidc", clientSecret: "private-client-secret" },
  });
  expect(auth).not.toContain("profileArn");
  expect(auth).not.toContain("secret-refresh");
  expect(auth).not.toContain("private-client-secret");
  let requested = false;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    requested = true;
    expect(url).toBe("https://runtime.eu-west-1.kiro.dev/");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-access");
    expect(headers.get("accept")).toBe("*/*");
    expect(headers.get("content-type")).toBe("application/x-amz-json-1.0");
    expect(headers.get("x-amz-target")).toBe("AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
    expect(headers.get("x-amzn-kiro-profile-arn")).toBeNull();
    expect(headers.get("x-amzn-codewhisperer-optout")).toBe("true");
    const body = String(init?.body);
    expect(body).not.toContain("secret-refresh");
    expect(body).not.toContain("private-client-secret");
    expect(body).not.toContain("secret-access");
    const request = JSON.parse(body);
    const state = request.conversationState;
    expect(state.chatTriggerType).toBe("MANUAL");
    expect(request.profileArn).toBe("arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX");
    expect(state.agentTaskType).toBe("vibe");
    expect(state.history[0].userInputMessage.content).toBe("System instruction\n\ncall it");
    expect(state.history[1].assistantResponseMessage.toolUses[0].name).toMatch(/^mcp_tool_with_spaces_[a-f0-9]{8}$/);
    expect(state.history[1].assistantResponseMessage.toolUses[0].input).toEqual({ x: "yes" });
    expect(state.currentMessage.userInputMessage.modelId).toBe("claude-haiku-4.5");
    expect(state.currentMessage.userInputMessage.origin).toBe("KIRO_CLI");
    expect(state.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.name).toMatch(/^mcp_tool_with_spaces_[a-f0-9]{8}$/);
    const result = state.currentMessage.userInputMessage.userInputMessageContext.toolResults[0];
    expect(result.content).toEqual([{ text: "done" }]);
    expect(result.status).toBe("success");
    expect(result.toolUseId).not.toBe("call/a");
    return framesToChunkedResponse([
      encodeEventFrame("messageMetadataEvent", { conversationId: "server-id" }),
      encodeEventFrame("assistantResponseEvent", { content: "Thanks" }),
    ]);
  }, { preconnect: globalThis.fetch.preconnect }));
  const { events, message } = await collect(ctx, { apiKey: auth });
  expect(requested).toBe(true);
  expect(events.map(e => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
  expect(message.content).toEqual([{ type: "text", text: "Thanks" }]);
  expect(message.responseId).toBe("server-id");
});

test("changing selected models routes the current turn, while Auto remains Auto", async () => {
  const ctx: OmpContext = { messages: [
    { role: "user", content: "First question" },
    { role: "assistant", content: [{ type: "text", text: "First answer" }] },
    { role: "user", content: "Second question" },
    { role: "assistant", content: [{ type: "text", text: "Second answer" }] },
    { role: "user", content: "Follow-up" },
  ] };
  const outbound: Array<{ current: string; conversationId: string }> = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const state = JSON.parse(String(init?.body)).conversationState;
    outbound.push({
      current: state.currentMessage.userInputMessage.modelId,
      conversationId: state.conversationId,
    });
    return framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "Answer from Kiro" })]);
  }, { preconnect: globalThis.fetch.preconnect }));
  for (const selected of ["gpt-5.6-sol", "claude-opus-5", "auto"]) {
    const { message } = await collect(ctx, { apiKey: "plain-access" }, { ...model, id: selected });
    expect(message.content).toEqual([{ type: "text", text: "Answer from Kiro" }]);
    expect(message.stopReason).toBe("stop");
  }
  expect(outbound.map(turn => turn.current)).toEqual(["gpt-5.6-sol", "claude-opus-5", "auto"]);
  expect(outbound[0].conversationId).not.toBe(outbound[1].conversationId);
  expect(outbound[1].conversationId).not.toBe(outbound[2].conversationId);
});

test("enterprise credential uses its own profile and IDE wire without CLI continuation", async () => {
  const profileArn = "arn:aws:codewhisperer:us-west-2:123456789012:profile/ENTERPRISE";
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(url).toBe("https://runtime.us-west-2.kiro.dev/");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer enterprise-access");
    expect(headers.get("x-amz-target")).toBe("AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
    expect(headers.get("x-amzn-kiro-profile-arn")).toBe(profileArn);
    const body = String(init?.body);
    expect(body).not.toContain("enterprise-refresh");
    expect(body).not.toContain("private-secret");
    expect(body).not.toContain("enterprise-access");
    const request = JSON.parse(body);
    expect(request.profileArn).toBe(profileArn);
    expect(request.conversationState.currentMessage.userInputMessage.origin).toBe("AI_EDITOR");
    expect(request.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-opus-5");
    expect(request.conversationState.agentTaskType).toBeUndefined();
    return framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "Enterprise reply" })]);
  }, { preconnect: globalThis.fetch.preconnect }));
  for (const authType of ["kiro_desktop", "aws_sso_oidc"] as const) {
    const auth = kiroOAuthProvider().getApiKey({
      access: "enterprise-access", refresh: "enterprise-refresh", expires: 0,
      kiro: { apiRegion: "us-west-2", profileArn, authType, clientSecret: "private-secret" },
    });
    const { message } = await collect(context, { apiKey: auth }, { ...model, id: "claude-opus-5" });
    expect(message.content).toEqual([{ type: "text", text: "Enterprise reply" }]);
  }
});

test("streams aliased tool object and chunked input as native calls", async () => {
  const name = "mcp/tool with spaces";
  const ctx: OmpContext = { messages: [{ role: "user", content: "go" }], tools: [{ name, parameters: { type: "object" } }] };
  const alias = buildKiroRequest(ctx, model.id).registry.alias(name);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => framesToChunkedResponse([
    encodeEventFrame("assistantResponseEvent", { content: "I will call it" }),
    encodeEventFrame("toolUseEvent", { toolUseId: "toolu-1", name: alias, input: '{"x":1}' }),
    encodeEventFrame("toolUseEvent", { toolUseId: "toolu-2", name: alias, input: '{"x":' }),
    encodeEventFrame("toolUseEvent", { toolUseId: "toolu-2", input: "2}", stop: true }),
  ]), { preconnect: globalThis.fetch.preconnect }));
  const { events, message } = await collect(ctx);
  expect(events.map(e => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
  expect(message.content).toEqual([
    { type: "text", text: "I will call it" },
    { type: "toolCall", id: "toolu-1", name, arguments: { x: 1 } },
    { type: "toolCall", id: "toolu-2", name, arguments: { x: 2 } },
  ]);
  expect(message.stopReason).toBe("toolUse");
});

test("GPT reasoning signature survives streaming and the next outbound history turn", async () => {
  const ctx: OmpContext = { messages: [{ role: "user", content: "Reason about this" }] };
  let followUp: { conversationState: { history?: Array<{ assistantResponseMessage?: { content: string; reasoningContent?: { signature: string } } }> } } | undefined;
  let requests = 0;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    if (requests === 1) return framesToChunkedResponse([
      encodeEventFrame("reasoningContentEvent", { text: "private reasoning", signature: "opaque-proof" }),
      encodeEventFrame("assistantResponseEvent", { content: "Public answer" }),
    ]);
    followUp = JSON.parse(String(init?.body));
    return framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "Follow-up answer" })]);
  }, { preconnect: globalThis.fetch.preconnect }));
  const selectedModel = { ...model, id: "gpt-5.6-sol" };
  const first = await collect(ctx, { apiKey: "plain-access" }, selectedModel);
  expect(first.events.map(event => event.type)).toEqual([
    "start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done",
  ]);
  expect(first.message.content).toEqual([
    { type: "thinking", thinking: "private reasoning", thinkingSignature: "kiro:signature:opaque-proof" },
    { type: "text", text: "Public answer" },
  ]);
  ctx.messages.push(first.message, { role: "user", content: "Continue" });
  const second = await collect(ctx, { apiKey: "plain-access" }, selectedModel);
  expect(second.message.content).toEqual([{ type: "text", text: "Follow-up answer" }]);
  expect(followUp?.conversationState.history?.[1].assistantResponseMessage).toEqual({
    content: "Public answer",
    reasoningContent: { signature: "opaque-proof" },
  });
});

test("reasoning without an answer or tool call cannot complete a turn", async () => {
  for (const reasoning of [{ signature: "opaque-proof" }, { text: "private reasoning", signature: "opaque-proof" }]) {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => framesToChunkedResponse([
      encodeEventFrame("reasoningContentEvent", reasoning),
    ]), { preconnect: globalThis.fetch.preconnect }));
    const { events, message } = await collect(context, { apiKey: "plain-access" }, { ...model, id: "gpt-5.6-sol" });
    expect(events.at(-1)?.type).toBe("error");
    expect(message.stopReason).toBe("error");
    expect(message.content.every(part => part.type === "thinking")).toBe(true);
    fetchSpy.mockRestore();
    fetchSpy = undefined;
  }
});

test("tool call result round-trip preserves history and completes next turn", async () => {
  const ctx: OmpContext = { messages: [{ role: "user", content: "calculate" }], tools: [{ name: "eval", parameters: { type: "object" } }] };
  const requests: Array<Record<string, unknown>> = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return framesToChunkedResponse(requests.length === 1 ? [
      encodeEventFrame("messageMetadataEvent", { conversationId: "server-turn-id" }),
      encodeEventFrame("toolUseEvent", { toolUseId: "toolu-1", name: "eval", input: '{"code":"2+2"}' }),
    ] : [
      encodeEventFrame("assistantResponseEvent", { content: "4" }),
    ]);
  }, { preconnect: globalThis.fetch.preconnect }));
  const first = await collect(ctx);
  expect(first.message.stopReason).toBe("toolUse");
  expect(first.message.responseId).toBe("server-turn-id");
  const call = first.message.content[0];
  expect(call).toEqual({ type: "toolCall", id: "toolu-1", name: "eval", arguments: { code: "2+2" } });
  if (call.type !== "toolCall") throw new Error("Expected a tool call");
  ctx.messages.push(first.message, {
    role: "toolResult", toolCallId: call.id, toolName: call.name,
    content: [{ type: "text", text: "4" }], isError: false,
  });
  const second = await collect(ctx);
  expect(second.message.content).toEqual([{ type: "text", text: "4" }]);
  expect(second.message.stopReason).toBe("stop");
  const state = requests[1].conversationState as { conversationId: string; history: Array<{ assistantResponseMessage?: { toolUses?: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> } }>; currentMessage: { userInputMessage: { userInputMessageContext: { toolResults: Array<{ toolUseId: string; status: string; content: Array<{ text: string }> }> } } } };
  expect(state.conversationId).toBe("server-turn-id");
  expect(state.history[1].assistantResponseMessage?.toolUses).toEqual([{ name: "eval", toolUseId: "toolu-1", input: { code: "2+2" } }]);
  expect(state.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([{ toolUseId: "toolu-1", status: "success", content: [{ text: "4" }] }]);
});

test("a tool-result continuation reuses the outbound ID when Kiro sends no conversation metadata", async () => {
  const ctx: OmpContext = { messages: [{ role: "user", content: "calculate" }], tools: [{ name: "eval", parameters: { type: "object" } }] };
  const ids: string[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const state = JSON.parse(String(init?.body)).conversationState;
    ids.push(state.conversationId);
    return framesToChunkedResponse(ids.length === 1
      ? [encodeEventFrame("toolUseEvent", { toolUseId: "toolu-1", name: "eval", input: '{"code":"2+2"}' })]
      : [encodeEventFrame("assistantResponseEvent", { content: "4" })]);
  }, { preconnect: globalThis.fetch.preconnect }));
  const first = await collect(ctx);
  expect(first.message.stopReason).toBe("toolUse");
  expect(first.message.responseId).toBe(ids[0]);
  ctx.messages.push(first.message, {
    role: "toolResult", toolCallId: "toolu-1", toolName: "eval",
    content: [{ type: "text", text: "4" }], isError: false,
  });
  const second = await collect(ctx);
  expect(second.message.content).toEqual([{ type: "text", text: "4" }]);
  expect(ids[1]).toBe(ids[0]);
});

test("missing credentials and malformed envelope are observable errors without network", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("unexpected network"); }, { preconnect: globalThis.fetch.preconnect }));
  const absent = await collect(context, {});
  expect(absent.events.map(e => e.type)).toEqual(["start", "error"]);
  expect(absent.message.errorMessage).toContain("No Kiro OAuth bearer token");
  const malformed = await collect(context, { apiKey: '{"version":1,"token":9}' });
  expect(malformed.message.errorMessage).toContain("Invalid Kiro OAuth credential envelope");
  const apiKey = await collect(context, { apiKey: "ksk_not-an-oauth-token" });
  expect(apiKey.message.errorMessage).toContain("separate API-key endpoint");
  const badRegion = await collect(context, { apiKey: '{"version":1,"token":"access","apiRegion":"evil.example/path"}' });
  expect(badRegion.message.errorMessage).toContain("Invalid Kiro AWS region");
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("complete string input ends the tool call before later text; nested fake payload is ignored", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => framesToChunkedResponse([
    encodeEventFrame("assistantResponseEvent", { assistantResponseEvent: { content: "nested fixture must be ignored" } }),
    encodeEventFrame("toolUseEvent", { toolUseId: "toolu-1", name: "eval", input: '{"code":"ok"}' }),
    encodeEventFrame("assistantResponseEvent", { content: "After tool" }),
  ]), { preconnect: globalThis.fetch.preconnect }));
  const ctx: OmpContext = { messages: [{ role: "user", content: "go" }], tools: [{ name: "eval", parameters: { type: "object" } }] };
  const { events, message } = await collect(ctx);
  expect(events.map(e => e.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "text_start", "text_delta", "text_end", "done"]);
  expect(message.content).toEqual([{ type: "toolCall", id: "toolu-1", name: "eval", arguments: { code: "ok" } }, { type: "text", text: "After tool" }]);
});

test("HTTP, Smithy exception, stream error and broken CRC fail as error events", async () => {
  const responses = [
    new Response("unauthorized", { status: 401 }),
    framesToChunkedResponse([encodeEventFrame("ValidationException", { message: "bad request" }, "exception")]),
    framesToChunkedResponse([encodeEventFrame("error", { message: "denied" }, "error")]),
    framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "before error" }), encodeEventFrame("invalidStateEvent", { message: "invalid state" })]),
    framesToChunkedResponse([new Uint8Array(encodeEventFrame("assistantResponseEvent", { content: "bad" })).fill(0, 8, 12)]),
  ];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => responses.shift()!, { preconnect: globalThis.fetch.preconnect }));
  for (const expected of ["HTTP 401", "ValidationException: bad request", "error: denied", "invalid state", "CRC mismatch"]) {
    const { events, message } = await collect();
    expect(events.at(-1)?.type).toBe("error");
    expect(message.errorMessage).toContain(expected);
  }
});

test("abort signal is forwarded and terminates with aborted reason", async () => {
  const controller = new AbortController();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.signal).toBe(controller.signal);
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  }, { preconnect: globalThis.fetch.preconnect }));
  const { message } = await collect(context, { apiKey: "plain-access", signal: controller.signal });
  expect(message.stopReason).toBe("aborted");
});

interface CapturedOutboundPayload {
  conversationState: {
    currentMessage: {
      userInputMessage: {
        content: string;
        modelId: string;
        origin: string;
        userInputMessageContext?: {
          tools?: unknown[];
          toolResults?: Array<{
            content: Array<{ text: string }>;
            status: string;
            toolUseId: string;
          }>;
        };
      };
    };
    history?: unknown[];
  };
  additionalModelRequestFields?: {
    reasoning?: { effort: string };
    output_config?: { effort: string };
  };
}

test("outbound JSON carries native reasoning.effort for GPT-5.6 at transport boundary", async () => {
  let capturedPayload: CapturedOutboundPayload | undefined;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedPayload = JSON.parse(String(init?.body)) as CapturedOutboundPayload;
        return framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "OK" })]);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  await collect(context, { apiKey: "plain-access", reasoning: "high" }, { ...model, id: "gpt-5.6-sol" });

  expect(capturedPayload?.additionalModelRequestFields).toEqual({
    reasoning: { effort: "high" },
  });
  expect(capturedPayload?.conversationState.currentMessage.userInputMessage.content).toBe("Be concise\n\nHello");
  expect(capturedPayload?.conversationState.currentMessage.userInputMessage.modelId).toBe("gpt-5.6-sol");
});

test("outbound JSON carries native output_config.effort for Opus 5 and 5.5 at transport boundary", async () => {
  const captured: CapturedOutboundPayload[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        captured.push(JSON.parse(String(init?.body)) as CapturedOutboundPayload);
        return framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "OK" })]);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  await collect(context, { apiKey: "plain-access", reasoning: "medium" }, { ...model, id: "claude-opus-5" });
  await collect(context, { apiKey: "plain-access", reasoning: "low" }, { ...model, id: "claude-opus-5.5" });

  expect(captured).toHaveLength(2);
  expect(captured[0].additionalModelRequestFields).toEqual({
    output_config: { effort: "medium" },
  });
  expect(captured[0].conversationState.currentMessage.userInputMessage.content).toBe("Be concise\n\nHello");
  expect(captured[0].conversationState.currentMessage.userInputMessage.modelId).toBe("claude-opus-5");

  expect(captured[1].additionalModelRequestFields).toEqual({
    output_config: { effort: "low" },
  });
  expect(captured[1].conversationState.currentMessage.userInputMessage.content).toBe("Be concise\n\nHello");
  expect(captured[1].conversationState.currentMessage.userInputMessage.modelId).toBe("claude-opus-5.5");
});

test("outbound JSON falls back to bounded thinking tags for Terra xhigh at transport boundary", async () => {
  let capturedPayload: CapturedOutboundPayload | undefined;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedPayload = JSON.parse(String(init?.body)) as CapturedOutboundPayload;
        return framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "OK" })]);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  await collect(
    context,
    { apiKey: "plain-access", reasoning: "xhigh", maxTokens: 5000 },
    { ...model, id: "gpt-5.6-terra" },
  );

  expect(capturedPayload?.additionalModelRequestFields).toBeUndefined();
  const content = capturedPayload?.conversationState.currentMessage.userInputMessage.content ?? "";
  expect(content).toContain("<thinking_mode>enabled</thinking_mode>");
  expect(content).toContain("<max_thinking_length>4500</max_thinking_length>");
  expect(content.endsWith("Hello")).toBe(true);
});

test("outbound JSON emulates effort with bounded thinking tags for non-native models", async () => {
  let capturedPayload: CapturedOutboundPayload | undefined;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedPayload = JSON.parse(String(init?.body)) as CapturedOutboundPayload;
        return framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "OK" })]);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  await collect(
    context,
    { apiKey: "plain-access", reasoning: "medium", maxTokens: 2000 },
    { ...model, id: "kiro-auto" },
  );

  expect(capturedPayload?.additionalModelRequestFields).toBeUndefined();
  const content = capturedPayload?.conversationState.currentMessage.userInputMessage.content ?? "";
  expect(content).toContain("<thinking_mode>enabled</thinking_mode>");
  expect(content).toContain("<max_thinking_length>1000</max_thinking_length>");
  expect(content.endsWith("Hello")).toBe(true);
});

test("outbound JSON leaves fields and content unmodified when reasoning is disabled or off", async () => {
  const captured: CapturedOutboundPayload[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        captured.push(JSON.parse(String(init?.body)) as CapturedOutboundPayload);
        return framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "OK" })]);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  await collect(
    context,
    { apiKey: "plain-access", reasoning: "high", disableReasoning: true },
    { ...model, id: "gpt-5.6-sol" },
  );
  await collect(
    context,
    { apiKey: "plain-access", reasoning: "high", forceReasoningOff: true },
    { ...model, id: "kiro-auto" },
  );

  expect(captured).toHaveLength(2);
  for (const payload of captured) {
    expect(payload.additionalModelRequestFields).toBeUndefined();
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe("Be concise\n\nHello");
  }
});

test("outbound JSON leaves tool-result turn content unmodified even with effort active", async () => {
  const toolCtx: OmpContext = {
    messages: [
      { role: "user", content: "Run action" },
      { role: "assistant", content: [{ type: "toolCall", id: "t-1", name: "tool_a", arguments: {} }] },
      { role: "toolResult", toolCallId: "t-1", toolName: "tool_a", content: [{ type: "text", text: "done" }], isError: false },
    ],
  };

  let capturedPayload: CapturedOutboundPayload | undefined;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedPayload = JSON.parse(String(init?.body)) as CapturedOutboundPayload;
        return framesToChunkedResponse([encodeEventFrame("assistantResponseEvent", { content: "Finished" })]);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  await collect(toolCtx, { apiKey: "plain-access", reasoning: "high" }, { ...model, id: "kiro-auto" });

  expect(capturedPayload?.additionalModelRequestFields).toBeUndefined();
  const current = capturedPayload?.conversationState.currentMessage.userInputMessage;
  expect(current?.content).not.toContain("<thinking_mode>");
  expect(current?.userInputMessageContext?.toolResults).toEqual([
    { toolUseId: "t-1", status: "success", content: [{ text: "done" }] },
  ]);
});
