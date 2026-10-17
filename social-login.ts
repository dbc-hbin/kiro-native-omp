import type { KiroCredential, KiroMetadata } from "./oauth";

export type SocialLoginProvider = "google" | "github";

export interface SocialLoginCallbacks {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onAuth?: (details: { url: string; launchUrl?: string; instructions?: string }) => void;
  onManualCodeInput?: (signal?: AbortSignal) => Promise<string>;
  onPrompt?: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean; secret?: boolean }) => Promise<string>;
}

const SIGNIN_URL = "https://app.kiro.dev/signin";
const TOKEN_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token";
const REDIRECT_URI = "http://localhost:3128";
const CALLBACK_PATH = "/oauth/callback";
const CALLBACK_PORT = "3128";
const FLOW_TIMEOUT_MS = 10 * 60_000;
const IDE_VERSION = "1.1.70";

function randomUrlSafe(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function optionForProvider(provider: SocialLoginProvider): string {
  return provider;
}

function providerLabel(provider: SocialLoginProvider): string {
  return provider === "google" ? "Google" : "GitHub";
}

function exchangeRedirectUri(provider: SocialLoginProvider): string {
  return `${REDIRECT_URI}${CALLBACK_PATH}?login_option=${optionForProvider(provider)}`;
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return ["access_denied", "invalid_client", "invalid_grant", "invalid_request", "server_error", "temporarily_unavailable"].includes(value)
    ? value
    : undefined;
}

function callbackError(message: string): Error {
  return new Error(message);
}

function callbackParams(input: string, provider: SocialLoginProvider, state: string): URLSearchParams {
  const value = input.trim();
  if (!value) throw callbackError("Kiro sign-in callback is empty");

  let params: URLSearchParams;
  try {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      const url = new URL(value);
      if (url.protocol !== "http:" || url.port !== CALLBACK_PORT || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== CALLBACK_PATH || url.hash || url.username || url.password) {
        throw callbackError("Kiro sign-in callback URL is invalid");
      }
      params = url.searchParams;
    } else {
      const queryLike = value.startsWith("?") || /(?:^|&)(?:state|login_option|error)=/.test(value);
      if (!queryLike) {
        params = new URLSearchParams({ state, login_option: optionForProvider(provider), code: value });
      } else {
        params = new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Kiro sign-in callback")) throw error;
    throw callbackError("Kiro sign-in callback URL is invalid");
  }

  if (params.getAll("state").length !== 1 || params.get("state") !== state) {
    throw callbackError("Kiro sign-in callback state is invalid");
  }
  if (params.getAll("login_option").length !== 1 || params.get("login_option") !== optionForProvider(provider)) {
    throw callbackError("Kiro sign-in callback provider is invalid");
  }
  if (params.getAll("code").length > 1 || params.getAll("error").length > 1) {
    throw callbackError("Kiro sign-in callback is invalid");
  }
  return params;
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function exchangeCode(
  fetchImpl: typeof globalThis.fetch,
  provider: SocialLoginProvider,
  verifier: string,
  code: string,
  machineId: string,
  signal?: AbortSignal,
): Promise<KiroCredential> {
  if (!code) throw new Error(`Kiro ${providerLabel(provider)} sign-in callback has no code`);
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": `KiroIDE-${IDE_VERSION}-${machineId}`,
    },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      redirect_uri: exchangeRedirectUri(provider),
    }),
    redirect: "error",
    signal,
  }).catch(() => {
    if (signal?.aborted) throw cancellationError();
    throw new Error(`Kiro ${providerLabel(provider)} token exchange failed`);
  });
  const data = await parseJson(response);
  if (!response.ok) {
    const codeName = safeErrorCode(data.error);
    throw new Error(`Kiro ${providerLabel(provider)} token exchange failed: HTTP ${response.status}${codeName ? ` (${codeName})` : ""}`);
  }
  const access = typeof data.accessToken === "string" ? data.accessToken : "";
  const refresh = typeof data.refreshToken === "string" ? data.refreshToken : "";
  const expiresIn = Number(data.expiresIn);
  if (!access || !refresh || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`Kiro ${providerLabel(provider)} token exchange returned incomplete credentials`);
  }
  const metadata: KiroMetadata = {
    apiRegion: "us-east-1",
    ssoRegion: "us-east-1",
    authType: "kiro_desktop",
    machineId: typeof data.machineId === "string" && data.machineId ? data.machineId : machineId,
    ...(typeof data.profileArn === "string" && data.profileArn ? { profileArn: data.profileArn } : {}),
  };
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
    ...(typeof data.accountId === "string" ? { accountId: data.accountId } : {}),
    ...(typeof data.email === "string" ? { email: data.email } : {}),
    kiro: metadata,
  };
}

function callbackPage(message: string, status: number): Response {
  return new Response(`<!doctype html><title>Kiro sign-in</title><p>${message}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function cancellationError(): Error {
  return new Error("Kiro sign-in cancelled");
}

export async function loginWithSocialProvider(provider: SocialLoginProvider, callbacks: SocialLoginCallbacks): Promise<KiroCredential> {
  const fetchImpl = callbacks.fetch ?? globalThis.fetch;
  const signal = callbacks.signal;
  if (signal?.aborted) throw cancellationError();

  const verifier = randomUrlSafe(32);
  const state = randomUrlSafe(16);
  const machineId = randomUrlSafe(16);
  const challenge = await codeChallenge(verifier);
  const authorizationUrl = new URL(SIGNIN_URL);
  authorizationUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("redirect_from", "KiroIDE");
  authorizationUrl.searchParams.set("signin_methods", optionForProvider(provider));

  callbacks.onProgress?.(`Preparing ${providerLabel(provider)} sign-in...`);

  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  for (const hostname of ["127.0.0.1", "::1"]) {
    try {
      servers.push(Bun.serve({
        hostname,
        port: 3128,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== CALLBACK_PATH) return callbackPage("Not found", 404);
          return consume(url.toString(), true);
        },
      }));
    } catch {
      // Try the other loopback family; a container may expose only one.
    }
  }
  const listenerAvailable = servers.length > 0;

  let claimed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flowController = new AbortController();
  const flowSignal = flowController.signal;
  const parentAbort = () => flowController.abort();
  signal?.addEventListener("abort", parentAbort, { once: true });
  let abortHandler: (() => void) | undefined;
  let finished = false;
  let resolveResult: (value: KiroCredential) => void = () => {};
  let rejectResult: (reason?: unknown) => void = () => {};
  const result = new Promise<KiroCredential>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (abortHandler) flowSignal.removeEventListener("abort", abortHandler);
    signal?.removeEventListener("abort", parentAbort);
    for (const server of servers) server.stop();
  };
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    flowController.abort();
    cleanup();
    rejectResult(error);
  };
  const complete = async (urlOrInput: string): Promise<"accepted" | "duplicate"> => {
    const params = callbackParams(urlOrInput, provider, state);
    if (claimed) return "duplicate";
    claimed = true;
    const callbackErrorValue = params.get("error");
    if (callbackErrorValue) {
      fail(new Error(`Kiro ${providerLabel(provider)} sign-in failed: ${safeErrorCode(callbackErrorValue) ?? "authorization denied"}`));
      return "accepted";
    }
    try {
      const credentials = await exchangeCode(fetchImpl, provider, verifier, params.get("code") ?? "", machineId, flowSignal);
      finished = true;
      cleanup();
      resolveResult(credentials);
    } catch (error) {
      fail(error);
    }
    return "accepted";
  };
  async function consume(urlOrInput: string, fromListener: boolean): Promise<Response> {
    if (claimed) return callbackPage("This sign-in is already being processed.", 409);
    try {
      const resultValue = await complete(urlOrInput);
      return callbackPage(resultValue === "duplicate" ? "This sign-in is already being processed." : "Sign-in received. You can close this tab.", resultValue === "duplicate" ? 409 : 200);
    } catch (error) {
      if (fromListener) return callbackPage(error instanceof Error ? error.message : "Invalid callback.", 400);
      throw error;
    }
  }

  timer = setTimeout(() => fail(new Error(`Kiro ${providerLabel(provider)} sign-in timed out`)), FLOW_TIMEOUT_MS);
  abortHandler = () => fail(cancellationError());
  flowSignal.addEventListener("abort", abortHandler, { once: true });

  const instructions = listenerAvailable
    ? `Complete ${providerLabel(provider)} sign-in in your browser.`
    : `Port 3128 is unavailable. Paste the full callback URL after completing ${providerLabel(provider)} sign-in.`;
  try {
    callbacks.onAuth?.({ url: authorizationUrl.toString(), instructions });
  } catch (error) {
    fail(error);
  }
  if (finished) return result;

  if (!listenerAvailable) {
    try {
      const input = callbacks.onManualCodeInput
        ? await callbacks.onManualCodeInput(flowSignal)
        : callbacks.onPrompt
          ? await Promise.race([
            callbacks.onPrompt({ message: "Paste the Kiro callback URL (or code):", placeholder: "http://localhost:3128/oauth/callback..." }),
            new Promise<string>((_, reject) => {
              flowSignal.addEventListener("abort", () => reject(cancellationError()), { once: true });
            }),
          ])
          : "";
      if (!input) fail(new Error("Kiro sign-in needs the callback URL"));
      else await consume(input, false);
    } catch (error) {
      fail(error);
    }
  } else if (!callbacks.onManualCodeInput && !callbacks.onPrompt) {
    callbacks.onProgress?.("Waiting for the Kiro browser callback...");
  }
  return result;
}

export { CALLBACK_PATH, REDIRECT_URI, TOKEN_URL, exchangeRedirectUri };
