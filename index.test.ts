import { describe, expect, test } from "bun:test";
import { buildKiroRequest, validateKiroConversation } from "./messages";
import { kiroOAuthProvider, refreshKiroCredential } from "./oauth";
import { buildKiroToolCatalog, createToolNameRegistry, ensureKiroRootObject, sanitizeKiroSchema } from "./schema";
import type { OmpContext } from "./types";

describe("Kiro native OMP translation", () => {
  test("sanitizes schema keywords without deleting properties named format/pattern", () => {
    const schema = sanitizeKiroSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        format: { type: "string", format: "uri", minLength: 1 },
        pattern: { type: "string", pattern: "x+" },
      },
      required: ["format"],
    }) as Record<string, unknown>;
    expect(schema.additionalProperties).toBeUndefined();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.format.type).toBe("string");
    expect(properties.format.format).toBeUndefined();
    expect(properties.pattern.type).toBe("string");
    expect(properties.pattern.pattern).toBeUndefined();
  });

  test("flattens root union to object", () => {
    const root = ensureKiroRootObject({
      oneOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(root.type).toBe("object");
    const properties = root.properties as Record<string, Record<string, unknown>>;
    expect(properties.a.type).toBe("string");
    expect(properties.b.type).toBe("number");
    expect(root.oneOf).toBeUndefined();
  });

  test("aliases unsafe and oversized tool names reversibly", () => {
    const registry = createToolNameRegistry();
    const original = `mcp__server__${"tool with spaces/".repeat(8)}`;
    const alias = registry.alias(original);
    expect(alias.length).toBeLessThanOrEqual(64);
    expect(alias).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(registry.restore(alias)).toBe(original);
  });

  test("builds a bounded Kiro tool catalog", () => {
    const tools = Array.from({ length: 60 }, (_, i) => ({
      name: `tool_${i}`,
      description: "x".repeat(2_000),
      parameters: { type: "object", properties: { value: { type: "string", minLength: 1 } } },
    }));
    const built = buildKiroToolCatalog(tools, "gpt-5.6-terra");
    expect(built.tools.length).toBeLessThanOrEqual(48);
    expect(new TextEncoder().encode(JSON.stringify(built.tools)).byteLength).toBeLessThanOrEqual(96_000);
    expect(built.omitted.length).toBeGreaterThan(0);
  });

  test("keeps eval admitted when the catalog is over budget", () => {
    const filler = Array.from({ length: 60 }, (_, i) => ({
      name: `filler_${i}`,
      description: "x".repeat(3_000),
      parameters: { type: "object", properties: { value: { type: "string" } } },
    }));
    const built = buildKiroToolCatalog(
      [...filler, { name: "eval", description: "execution bridge", parameters: { type: "object", properties: { code: { type: "string" } } } }],
      "gpt-5.6-terra",
      undefined,
      ["eval"],
    );
    expect(built.tools.some(tool => tool.toolSpecification.name === "eval")).toBe(true);
  });

  test("honors toolChoice:none and refuses unsupported forced choices", () => {
    const context: OmpContext = {
      messages: [{ role: "user", content: "no tools" }],
      tools: [{ name: "kiro_mock_probe", description: "probe", parameters: { type: "object", properties: {} } }],
    };
    const none = buildKiroRequest(context, "gpt-5.6-sol", { toolChoice: "none" });
    expect(none.payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools).toBeUndefined();
    expect(() => buildKiroRequest(context, "gpt-5.6-sol", { toolChoice: "required" })).toThrow(/supports only automatic tool choice/);
    expect(() => buildKiroRequest(context, "gpt-5.6-sol", { toolChoice: { type: "tool", name: "kiro_mock_probe" } })).toThrow(/supports only automatic tool choice/);
  });

  test("serializes tool-only assistant and result as adjacent AWS turns", () => {
    const context: OmpContext = {
      systemPrompt: ["system"],
      tools: [{ name: "kiro_mock_probe", description: "probe", parameters: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "kiro_mock_probe", arguments: {} }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "kiro_mock_probe", content: [{ type: "text", text: "done" }], isError: false },
      ],
    };
    const built = buildKiroRequest(context, "gpt-5.6-sol", undefined, ["kiro_mock_probe"]);
    validateKiroConversation(built.payload);
    const { history, currentMessage } = built.payload.conversationState;
    expect(history?.[0].userInputMessage).toEqual({ content: "system\n\ngo", origin: "CLI" });
    expect(history?.[1].assistantResponseMessage).toEqual({
      content: "",
      toolUses: [{ toolUseId: "call-1", name: "kiro_mock_probe", input: {} }],
    });
    expect(currentMessage.userInputMessage.userInputMessageContext?.toolResults).toEqual([
      { toolUseId: "call-1", status: "success", content: [{ text: "done" }] },
    ]);
    expect(currentMessage.userInputMessage.userInputMessageContext?.tools?.[0].toolSpecification.name).toBe("kiro_mock_probe");
    expect(currentMessage.userInputMessage.origin).toBe("CLI");
    expect(currentMessage.userInputMessage).not.toHaveProperty("modelId");
  });

  test("replays historical tool calls even when they are absent from the current catalog", () => {
    const context: OmpContext = {
      tools: [{ name: "different_current_tool", description: "current", parameters: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "toolCall", id: "old-call", name: "old_tool", arguments: { x: 1 } }] },
        { role: "toolResult", toolCallId: "old-call", toolName: "old_tool", content: [{ type: "text", text: "old-result" }], isError: false },
      ],
    };
    const built = buildKiroRequest(context, "gpt-5.6-sol");
    validateKiroConversation(built.payload);
    const history = built.payload.conversationState.history ?? [];
    expect(history[1].assistantResponseMessage?.toolUses).toEqual([{ name: "old_tool", input: { x: 1 }, toolUseId: "old-call" }]);
    expect(built.payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0].content).toEqual([{ text: "old-result" }]);
  });

  test("preserves aliased tool identity and interleaves results with later turns", () => {
    const name = "mcp/server.tool with spaces";
    const context: OmpContext = {
      tools: [{ name, description: "probe", parameters: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "inspect" },
        { role: "assistant", content: [
          { type: "text", text: "checking" },
          { type: "toolCall", id: "call/first", name, arguments: { path: "x" } },
        ] },
        { role: "toolResult", toolCallId: "call/first", toolName: name, content: [{ type: "text", text: "failed" }], isError: true },
        { role: "user", content: "try again" },
        { role: "assistant", content: [{ type: "text", text: "retrying" }] },
        { role: "user", content: "okay" },
      ],
    };
    const { payload, registry } = buildKiroRequest(context, "gpt-5.6-sol");
    validateKiroConversation(payload);
    const history = payload.conversationState.history ?? [];
    const call = history[1].assistantResponseMessage?.toolUses?.[0];
    expect(history[1].assistantResponseMessage?.content).toBe("checking");
    expect(call?.input).toEqual({ path: "x" });
    if (!call) throw new Error("Expected a serialized tool call");
    expect(registry.restore(call.name)).toBe(name);
    expect(history[2].userInputMessage?.content).toBe("try again");
    expect(history[2].userInputMessage?.userInputMessageContext?.toolResults).toEqual([
      { toolUseId: call.toolUseId, status: "error", content: [{ text: "failed" }] },
    ]);
    expect(history[3].assistantResponseMessage).toEqual({ content: "retrying" });
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe("okay");
  });

  test("rejects empty AWS result content and empty assistant turns", () => {
    const context: OmpContext = { messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "text", text: "ok" }], isError: false },
    ] };
    const { payload } = buildKiroRequest(context, "gpt-5.6-sol");
    const result = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0];
    if (!result) throw new Error("expected tool result");
    result.content = [{ text: " " }];
    expect(() => validateKiroConversation(payload)).toThrow(/tool result is empty/);
    result.content = [{ text: "ok" }];
    const assistant = payload.conversationState.history?.[1].assistantResponseMessage;
    if (!assistant) throw new Error("expected assistant response");
    assistant.toolUses = [];
    expect(() => validateKiroConversation(payload)).toThrow(/assistant message is empty/);
  });

  test("hashes rewritten tool ids so lossy normalization cannot collide", () => {
    const context: OmpContext = {
      tools: [{ name: "kiro_mock_probe", description: "probe", parameters: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [
          { type: "toolCall", id: "call/a", name: "kiro_mock_probe", arguments: { x: 1 } },
          { type: "toolCall", id: "call a", name: "kiro_mock_probe", arguments: { x: 2 } },
        ] },
        { role: "toolResult", toolCallId: "call/a", toolName: "kiro_mock_probe", content: [{ type: "text", text: "one" }], isError: false },
        { role: "toolResult", toolCallId: "call a", toolName: "kiro_mock_probe", content: [{ type: "text", text: "two" }], isError: false },
      ],
    };
    const built = buildKiroRequest(context, "gpt-5.6-sol");
    validateKiroConversation(built.payload);
    const ids = (built.payload.conversationState.history ?? [])
      .flatMap(entry => entry.assistantResponseMessage?.toolUses ?? [])
      .map(call => call.toolUseId);
    expect(new Set(ids).size).toBe(2);
    expect(built.payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.map(result => result.toolUseId)).toEqual(ids);
  });

  test("fails closed instead of silently dropping unsupported images", () => {
    const userImage: OmpContext = {
      messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AA==" }] }],
    };
    expect(() => buildKiroRequest(userImage, "gpt-5.6-sol")).toThrow(/does not translate user image/);
    const toolImage: OmpContext = {
      tools: [{ name: "kiro_mock_probe", description: "probe", parameters: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "toolCall", id: "img", name: "kiro_mock_probe", arguments: {} }] },
        { role: "toolResult", toolCallId: "img", toolName: "kiro_mock_probe", content: [{ type: "image", mimeType: "image/png", data: "AA==" }], isError: false },
      ],
    };
    expect(() => buildKiroRequest(toolImage, "gpt-5.6-sol")).toThrow(/does not translate tool-result image/);
  });

  test("OAuth login surfaces the real AWS device authorization URL", async () => {
    const responses = [
      new Response(JSON.stringify({ clientId: "client", clientSecret: "secret", clientSecretExpiresAt: 4_000_000_000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({
        deviceCode: "device",
        userCode: "ABCD-EFGH",
        verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
        verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
        interval: 0,
        expiresIn: 60,
      }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    const fetchImpl = Object.assign(async () => responses.shift()!, { preconnect: globalThis.fetch.preconnect });
    let authUrl = "";
    const credentials = await kiroOAuthProvider().login({
      fetch: fetchImpl,
      onAuth(info: { url: string }) { authUrl = info.url; },
    });
    expect(authUrl).toBe("https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH");
    expect(authUrl).not.toContain("example.invalid");
    expect(credentials.access).toBe("access");
    expect(credentials.kiro?.clientId).toBe("client");
  });

  test("OAuth refresh preserves Kiro private metadata", async () => {
    const original = {
      access: "a",
      refresh: "r",
      expires: 1,
      accountId: "id",
      kiro: { profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/X", clientId: "c", clientSecret: "s", authType: "aws_sso_oidc" as const },
    };
    const fetchImpl = Object.assign(async () => new Response(JSON.stringify({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect });
    const refreshed = await refreshKiroCredential(original, fetchImpl);
    expect(refreshed.kiro).toEqual(original.kiro);
    expect(refreshed.refresh).toBe("new-refresh");
    expect(refreshed.access).toBe("new-access");
  });

});
