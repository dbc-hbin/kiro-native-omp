import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fetchKiroModels } from "./catalog";
import { BUILDER_ID_SERVICE_PROFILE_ARN, KIRO_EFFORTS } from "./constants";

const VALID_TOKEN = "builder-id-test-token";
let fetchSpy: { mockRestore(): void } | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

describe("Kiro account model catalog discovery", () => {
  test("queries management endpoint with Builder ID profile and maps account model definitions", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;
    let capturedBody: string | undefined;
    let capturedMethod: string | undefined;
    let capturedRedirect: RequestRedirect | undefined;

    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          capturedUrl = input.toString();
          capturedMethod = init?.method;
          capturedRedirect = init?.redirect;
          capturedHeaders = new Headers(init?.headers);
          capturedBody = typeof init?.body === "string" ? init.body : undefined;

          return new Response(
            JSON.stringify({
              models: [
                { modelId: "claude-sonnet-4.5", tokenLimits: { maxInputTokens: 200_000 } },
                { modelId: "custom-account-model", tokenLimits: { maxInputTokens: 128_000 } },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );

    const models = await fetchKiroModels(VALID_TOKEN);

    const parsedUrl = new URL(capturedUrl ?? "");
    expect(parsedUrl.origin).toBe("https://management.us-east-1.kiro.dev");
    expect(parsedUrl.searchParams.get("origin")).toBe("AI_EDITOR");
    expect(parsedUrl.searchParams.get("profileArn")).toBe(BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(capturedMethod).toBe("POST");
    expect(capturedRedirect).toBe("error");
    expect(capturedHeaders?.get("authorization")).toBe(`Bearer ${VALID_TOKEN}`);
    expect(capturedHeaders?.get("x-amz-target")).toBe("KiroControlPlaneBearerService.ListAvailableModels");
    expect(capturedHeaders?.get("x-amzn-codewhisperer-optout")).toBe("true");
    expect(capturedBody).toBe(
      JSON.stringify({ origin: "AI_EDITOR", profileArn: BUILDER_ID_SERVICE_PROFILE_ARN }),
    );

    const sonnet = models.find((m) => m.id === "claude-sonnet-4.5");
    expect(sonnet?.contextWindow).toBe(200_000);
    expect(sonnet?.reasoning).toBe(true);
    expect(sonnet?.thinking).toEqual({
      mode: "effort",
      efforts: KIRO_EFFORTS,
    });

    const custom = models.find((m) => m.id === "custom-account-model");
    expect(custom?.contextWindow).toBe(128_000);
    expect(custom?.maxTokens).toBe(32_000);
    expect(custom?.reasoning).toBe(true);
    expect(custom?.thinking).toEqual({
      mode: "effort",
      efforts: KIRO_EFFORTS,
    });
  });

  test("filters duplicate and malformed model rows", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_input: RequestInfo | URL, _init?: RequestInit) => {
          return new Response(
            JSON.stringify({
              models: [
                { modelId: "model-alpha", tokenLimits: { maxInputTokens: 64_000 } },
                { modelId: "model-alpha", tokenLimits: { maxInputTokens: 128_000 } },
                null,
                {},
                { modelId: "" },
                { modelId: "invalid\nname" },
                { modelId: " trailing " },
                { modelId: 12345 },
                { modelId: "model-beta" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );

    const models = await fetchKiroModels(VALID_TOKEN);
    expect(models.map((m) => m.id)).toEqual(["model-alpha", "model-beta"]);
    expect(models[0].contextWindow).toBe(64_000);
  });

  test("rejects non-OAuth credentials before invoking fetch", async () => {
    let invoked = false;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_input: RequestInfo | URL, _init?: RequestInit) => {
          invoked = true;
          return new Response("{}", { status: 200 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );

    await expect(fetchKiroModels(undefined)).rejects.toThrow();
    await expect(fetchKiroModels("   ")).rejects.toThrow();
    await expect(fetchKiroModels("ksk_local_key")).rejects.toThrow();
    await expect(fetchKiroModels('{"access":"token"}')).rejects.toThrow();
    expect(invoked).toBe(false);
  });

  test("rejects on HTTP error or malformed body without returning fallback models", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_input: RequestInfo | URL, _init?: RequestInit) => {
          return new Response("Unauthorized", { status: 401 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    await expect(fetchKiroModels(VALID_TOKEN)).rejects.toThrow();

    fetchSpy.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_input: RequestInfo | URL, _init?: RequestInit) => {
          return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    await expect(fetchKiroModels(VALID_TOKEN)).rejects.toThrow();
  });
});
