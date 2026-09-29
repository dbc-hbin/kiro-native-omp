import { describe, expect, test } from "bun:test";
import { KIRO_EFFORTS, type KiroEffort } from "./constants";
import kiroNativeExtension from "./index";
import { buildKiroRequest, validateKiroConversation } from "./messages";
import { kiroOAuthProvider, refreshKiroCredential } from "./oauth";
import { buildKiroToolCatalog, createToolNameRegistry, ensureKiroRootObject, sanitizeKiroSchema } from "./schema";
import type { OmpContext, StreamOptionsLike } from "./types";

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

  test("toolChoice narrows the offered catalog instead of failing the request", () => {
    const tools = [
      { name: "alpha", description: "a", parameters: { type: "object", properties: {} } },
      { name: "beta", description: "b", parameters: { type: "object", properties: {} } },
    ];
    const context: OmpContext = { messages: [{ role: "user", content: "go" }], tools };
    const offered = (toolChoice: StreamOptionsLike["toolChoice"]) =>
      buildKiroRequest(context, "gpt-5.6-sol", { toolChoice }).payload.conversationState.currentMessage.userInputMessage
        .userInputMessageContext?.tools?.map(tool => tool.toolSpecification.name);
    expect(offered("none")).toBeUndefined();
    expect(offered("required")).toEqual(["alpha", "beta"]);
    expect(offered({ type: "tool", name: "beta" })).toEqual(["beta"]);
    expect(offered({ type: "function", function: { name: "alpha" } })).toEqual(["alpha"]);
    // A choice naming an absent tool must not strip the catalog to nothing.
    expect(offered({ type: "tool", name: "missing" })).toEqual(["alpha", "beta"]);
  });

  test("pairs every replayed tool call with exactly one adjacent result", () => {
    const tools = [{ name: "bash", parameters: { type: "object" } }];
    const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: {} });
    const result = (id: string, text: string) => ({
      role: "toolResult" as const, toolCallId: id, toolName: "bash", content: [{ type: "text" as const, text }], isError: false,
    });
    const context: OmpContext = {
      tools,
      messages: [
        { role: "user", content: "run" },
        { role: "assistant", stopReason: "aborted", content: [call("aborted-call")] },
        { role: "user", content: "again" },
        { role: "assistant", stopReason: "toolUse", content: [call("a"), call("b")] },
        result("a", "first"),
        result("a", "duplicate"),
        { role: "user", content: "next" },
        result("folded-away", "stale output"),
        { role: "user", content: "finish" },
      ],
    };
    const built = buildKiroRequest(context, "claude-opus-5.5");
    validateKiroConversation(built.payload);
    const { history = [], currentMessage } = built.payload.conversationState;
    // Consecutive user content merges into one Kiro user turn; the last is current.
    const users = [...history.flatMap(entry => entry.userInputMessage ? [entry.userInputMessage] : []), currentMessage.userInputMessage];
    const results = users.map(user => user.userInputMessageContext?.toolResults);
    expect(users.map(user => user.content)).toEqual([
      "run",
      "again",
      "next\n\n<stale-tool-result tool=\"bash\" id=\"folded-away\">\nstale output\n</stale-tool-result>\n\nfinish",
    ]);
    expect(results[1]).toEqual([{ toolUseId: "aborted-call", status: "error", content: [{ text: "aborted" }] }]);
    expect(results[2]).toEqual([
      { toolUseId: "a", status: "success", content: [{ text: "first" }] },
      { toolUseId: "b", status: "error", content: [{ text: "No result provided" }] },
    ]);
    expect(JSON.stringify(built.payload)).not.toContain("duplicate");
  });

  test("serializes tool-only assistant and result as adjacent Kiro turns", () => {
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
    expect(history?.[0].userInputMessage).toEqual({ content: "system\n\ngo", origin: "KIRO_CLI", modelId: "gpt-5.6-sol" });
    expect(history?.[1].assistantResponseMessage).toEqual({
      content: "",
      toolUses: [{ toolUseId: "call-1", name: "kiro_mock_probe", input: {} }],
    });
    expect(currentMessage.userInputMessage.userInputMessageContext?.toolResults).toEqual([
      { toolUseId: "call-1", status: "success", content: [{ text: "done" }] },
    ]);
    expect(currentMessage.userInputMessage.userInputMessageContext?.tools?.[0].toolSpecification.name).toBe("kiro_mock_probe");
    expect(currentMessage.userInputMessage.origin).toBe("KIRO_CLI");
    expect(currentMessage.userInputMessage.modelId).toBe("gpt-5.6-sol");
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

  test("rejects empty Kiro result content and empty assistant turns", () => {
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
    expect(credentials.kiro?.profileArn).toBeUndefined();
  });

  test("OAuth refresh preserves Kiro private metadata", async () => {
    const original = {
      access: "a",
      refresh: "r",
      expires: 1,
      accountId: "id",
      kiro: { profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/X", clientId: "c", clientSecret: "s", authType: "kiro_desktop" as const },
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

  test("translates selected model IDs to expected wire modelId for Kiro", () => {
    const context: OmpContext = {
      messages: [{ role: "user", content: "hello" }],
    };

    const cases = [
      { selected: "kiro-auto", expected: "auto" },
      { selected: "claude-opus-5.5", expected: "claude-opus-5.5" },
      { selected: "gpt-6-sol", expected: "gpt-6-sol" },
      { selected: "gpt-6-luna", expected: "gpt-6-luna" },
    ] as const;

    for (const { selected, expected } of cases) {
      const request = buildKiroRequest(context, selected);
      expect(request.payload.conversationState.currentMessage.userInputMessage.modelId).toBe(expected);
    }
  });

  test("registers static models with reasoning enabled and standard effort choices", () => {
    interface ProviderModelEntry {
      id: string;
      name: string;
      reasoning: boolean;
      thinking?: {
        mode: string;
        efforts: readonly string[];
      };
    }
    interface ProviderRegistration {
      models?: ProviderModelEntry[];
    }

    let registered: ProviderRegistration | undefined;
    kiroNativeExtension({
      setLabel() {},
      registerProvider(_id: string, config: unknown) {
        registered = config as ProviderRegistration;
      },
      logger: { debug() {} },
    });

    const ids = registered?.models?.map(entry => entry.id) ?? [];
    expect(ids).toContain("claude-opus-5.5");
    expect(registered?.models?.find(entry => entry.id === "claude-sonnet-5.5")).toMatchObject({
      name: "Claude Sonnet 5.5",
      contextWindow: 1_000_000,
    });
    // Unpublished gpt-6 IDs fail upstream; `kiro-auto` duplicated Kiro's `auto`.
    for (const absent of ["gpt-6-sol", "gpt-6-luna", "kiro-auto", "claude-sonnet-4.0"]) {
      expect(ids).not.toContain(absent);
    }
    for (const entry of registered?.models ?? []) {
      expect(entry.reasoning).toBe(true);
      expect(entry.thinking).toEqual({
        mode: "effort",
        efforts: KIRO_EFFORTS,
      });
    }
  });

  test("maps native reasoning.effort for GPT-5.6 and GPT-6 models without thinking tags", () => {
    const context: OmpContext = {
      messages: [{ role: "user", content: "Solve this" }],
    };

    const cases: Array<{ modelId: string; effort: KiroEffort }> = [
      { modelId: "gpt-5.6-sol", effort: "xhigh" },
      { modelId: "gpt-5.6-terra", effort: "medium" },
      { modelId: "gpt-5.6-luna", effort: "low" },
      { modelId: "gpt-6-sol", effort: "max" },
      { modelId: "gpt-6-luna", effort: "high" },
    ];

    for (const { modelId, effort } of cases) {
      const built = buildKiroRequest(context, modelId, { reasoning: effort });
      expect(built.payload.additionalModelRequestFields).toEqual({
        reasoning: { effort },
      });
      expect(built.payload.conversationState.currentMessage.userInputMessage.content).toBe("Solve this");
    }
  });

  test("maps native output_config.effort for Opus 5 and Opus 5.5 without thinking tags", () => {
    const context: OmpContext = {
      messages: [{ role: "user", content: "Compose an essay" }],
    };

    const cases: Array<{ modelId: string; effort: KiroEffort }> = [
      { modelId: "claude-opus-5", effort: "xhigh" },
      { modelId: "claude-opus-5.5", effort: "high" },
    ];

    for (const { modelId, effort } of cases) {
      const built = buildKiroRequest(context, modelId, { reasoning: effort });
      expect(built.payload.additionalModelRequestFields).toEqual({
        output_config: { effort },
      });
      expect(built.payload.conversationState.currentMessage.userInputMessage.content).toBe("Compose an essay");
    }
  });

  test("falls back to bounded thinking tags for Terra and Luna on xhigh", () => {
    const context: OmpContext = {
      messages: [{ role: "user", content: "Deep problem" }],
    };

    const terra = buildKiroRequest(context, "gpt-5.6-terra", { reasoning: "xhigh", maxTokens: 4000 });
    expect(terra.payload.additionalModelRequestFields).toBeUndefined();
    const terraContent = terra.payload.conversationState.currentMessage.userInputMessage.content;
    expect(terraContent).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(terraContent).toContain("<max_thinking_length>3600</max_thinking_length>");
    expect(terraContent).toContain("<thinking_instruction>");
    expect(terraContent.endsWith("Deep problem")).toBe(true);

    const lunaDefault = buildKiroRequest(context, "gpt-5.6-luna", { reasoning: "xhigh" });
    expect(lunaDefault.payload.additionalModelRequestFields).toBeUndefined();
    const lunaContent = lunaDefault.payload.conversationState.currentMessage.userInputMessage.content;
    expect(lunaContent).toContain("<max_thinking_length>3686</max_thinking_length>");

    const boundedMin = buildKiroRequest(context, "gpt-5.6-terra", { reasoning: "xhigh", maxTokens: 1 });
    const minContent = boundedMin.payload.conversationState.currentMessage.userInputMessage.content;
    expect(minContent).toContain("<max_thinking_length>1</max_thinking_length>");
  });

  test("emulates effort via bounded thinking tags for non-native models", () => {
    const context: OmpContext = {
      messages: [{ role: "user", content: "Plan architecture" }],
    };

    const ratios: Array<{ effort: KiroEffort; maxTokens: number; expectedLength: number }> = [
      { effort: "low", maxTokens: 1000, expectedLength: 200 },
      { effort: "medium", maxTokens: 2000, expectedLength: 1000 },
      { effort: "high", maxTokens: 1000, expectedLength: 800 },
      { effort: "xhigh", maxTokens: 1000, expectedLength: 900 },
      { effort: "max", maxTokens: 1000, expectedLength: 950 },
    ];

    for (const { effort, maxTokens, expectedLength } of ratios) {
      const built = buildKiroRequest(context, "kiro-auto", { reasoning: effort, maxTokens });
      expect(built.payload.additionalModelRequestFields).toBeUndefined();
      const content = built.payload.conversationState.currentMessage.userInputMessage.content;
      expect(content).toContain("<thinking_mode>enabled</thinking_mode>");
      expect(content).toContain(`<max_thinking_length>${expectedLength}</max_thinking_length>`);
      expect(content.endsWith("Plan architecture")).toBe(true);
    }
  });

  test("leaves content and fields unmodified when effort is omitted", () => {
    const context: OmpContext = {
      messages: [{ role: "user", content: "Standard prompt" }],
    };

    const noEffort = buildKiroRequest(context, "gpt-5.6-sol");
    expect(noEffort.payload.additionalModelRequestFields).toBeUndefined();
    expect(noEffort.payload.conversationState.currentMessage.userInputMessage.content).toBe("Standard prompt");
  });

  test("leaves continuation messages unmodified with emulated effort active", () => {
    const continuationContext: OmpContext = {
      messages: [
        { role: "user", content: "First part" },
        { role: "assistant", content: [{ type: "text", text: "Incomplete" }] },
      ],
    };

    const continuationRequest = buildKiroRequest(continuationContext, "kiro-auto", { reasoning: "high" });
    expect(continuationRequest.payload.additionalModelRequestFields).toBeUndefined();
    const continuationContent = continuationRequest.payload.conversationState.currentMessage.userInputMessage.content;
    expect(continuationContent).not.toContain("<thinking_mode>");
  });

  test("rejects unsupported reasoning effort on native models", () => {
    const context: OmpContext = {
      messages: [{ role: "user", content: "Test invalid" }],
    };

    expect(() =>
      buildKiroRequest(context, "gpt-5.6-sol", { reasoning: "minimal" as unknown as KiroEffort }),
    ).toThrow(/does not support reasoning effort "minimal"/);
  });

});
