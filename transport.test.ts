import { afterEach, expect, spyOn, test } from "bun:test";
import { encodeEventFrame, framesToChunkedResponse } from "./eventstream";
import { buildKiroRequest } from "./messages";
import { kiroOAuthProvider } from "./oauth";
import { streamKiro } from "./stream";
import type { OmpAssistantEvent, OmpContext, StreamOptionsLike } from "./types";

const model = { id: "claude-haiku-4-5", provider: "kiro-native", api: "kiro-codewhisperer-stream" };
const context: OmpContext = { systemPrompt: "Be concise", messages: [{ role: "user", content: "Hello" }] };
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; });

async function collect(ctx: OmpContext = context, options: StreamOptionsLike = { apiKey: "plain-access" }) {
  const stream = streamKiro(model, ctx, options);
  const events: OmpAssistantEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

test("OAuth credential envelope sends only bearer token, region/profile and official conversation wire", async () => {
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
    kiro: { apiRegion: "eu-west-1", profileArn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/X", clientSecret: "private-client-secret" },
  });
  let requested = false;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    requested = true;
    expect(url).toBe("https://codewhisperer.eu-west-1.amazonaws.com/generateAssistantResponse");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-access");
    expect(headers.get("accept")).toBe("application/vnd.amazon.eventstream");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("amzn-x-amz-target")).toBe("AmazonCodeWhispererService.GenerateAssistantResponse");
    expect(headers.get("x-amzn-codewhisperer-proflearn")).toBe("arn:aws:codewhisperer:eu-west-1:123456789012:profile/X");
    const body = String(init?.body);
    expect(body).not.toContain("secret-refresh");
    expect(body).not.toContain("private-client-secret");
    expect(body).not.toContain("secret-access");
    const request = JSON.parse(body);
    const state = request.conversationState;
    expect(state.chatTriggerType).toBe("MANUAL");
    expect(state.conversationId).toBeUndefined();
    expect(request.profileArn).toBe("arn:aws:codewhisperer:eu-west-1:123456789012:profile/X");
    expect(state.history[0].userInputMessage.content).toBe("System instruction\n\ncall it");
    expect(state.history[1].assistantResponseMessage.toolUses[0].name).toMatch(/^mcp_tool_with_spaces_[a-f0-9]{8}$/);
    expect(state.history[1].assistantResponseMessage.toolUses[0].input).toEqual({ x: "yes" });
    expect(state.currentMessage.userInputMessage.modelId).toBeUndefined();
    expect(state.currentMessage.userInputMessage.origin).toBe("CLI");
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

test("streams aliased tool object and chunked input as native calls", async () => {
  const name = "mcp/tool with spaces";
  const ctx: OmpContext = { messages: [{ role: "user", content: "go" }], tools: [{ name, parameters: { type: "object" } }] };
  const alias = buildKiroRequest(ctx, model.id).registry.alias(name);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => framesToChunkedResponse([
    encodeEventFrame("assistantResponseEvent", { content: "I will call it" }),
    encodeEventFrame("toolUseEvent", { toolUseId: "toolu-1", name: alias, input: { x: 1 } }),
    encodeEventFrame("toolUseEvent", { toolUseId: "toolu-2", name: alias, input: '{"x":' }),
    encodeEventFrame("toolUseEvent", { toolUseId: "toolu-2", input: "2}", stop: { stopReason: "TOOL_USE" } }),
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

test("tool call result round-trip uses AWS modeled history and completes next turn", async () => {
  const ctx: OmpContext = { messages: [{ role: "user", content: "calculate" }], tools: [{ name: "eval", parameters: { type: "object" } }] };
  const requests: Array<Record<string, unknown>> = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return framesToChunkedResponse(requests.length === 1 ? [
      encodeEventFrame("toolUseEvent", { toolUseId: "toolu-1", name: "eval", input: { code: "2+2" } }),
    ] : [
      encodeEventFrame("assistantResponseEvent", { content: "4" }),
    ]);
  }, { preconnect: globalThis.fetch.preconnect }));
  const first = await collect(ctx);
  expect(first.message.stopReason).toBe("toolUse");
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
  const state = requests[1].conversationState as { history: Array<{ assistantResponseMessage?: { toolUses?: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> } }>; currentMessage: { userInputMessage: { userInputMessageContext: { toolResults: Array<{ toolUseId: string; status: string; content: Array<{ text: string }> }> } } } };
  expect(state.history[1].assistantResponseMessage?.toolUses).toEqual([{ name: "eval", toolUseId: "toolu-1", input: { code: "2+2" } }]);
  expect(state.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([{ toolUseId: "toolu-1", status: "success", content: [{ text: "4" }] }]);
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
