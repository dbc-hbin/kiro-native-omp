import { loginWithKiroBrowser } from "./social-login";
const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const DEFAULT_REGION = "us-east-1";
const CLIENT_NAME = "omp-kiro-native";
const CODEWHISPERER_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
  "sso:account:access",
];

export interface KiroMetadata {
  profileArn?: string;
  ssoRegion?: string;
  apiRegion?: string;
  clientId?: string;
  clientSecret?: string;
  machineId?: string;
  authType?: "kiro_desktop" | "aws_sso_oidc";
}

export type KiroCredential = {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
  kiro?: KiroMetadata;
};

interface RegisterClientResponse {
  clientId: string;
  clientSecret: string;
  clientSecretExpiresAt?: number;
}

interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval?: number;
  expiresIn: number;
}

interface TokenSuccess {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

type FetchLike = typeof globalThis.fetch;

interface LoginCallbacks {
  fetch?: FetchLike;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onAuth?: (details: { url: string; launchUrl?: string; instructions?: string }) => void;
  onPrompt?: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean; secret?: boolean }) => Promise<string>;
  onManualCodeInput?: (signal?: AbortSignal) => Promise<string>;
  onBuilderId?: (
    details: { startUrl: string; region: string },
    signal?: AbortSignal,
  ) => Promise<KiroCredential>;
}

function oidcUrl(region: string, path: string): string {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new Error("Invalid AWS region " + region);
  return "https://oidc." + region + ".amazonaws.com" + path;
}

function desktopRefreshUrl(region: string): string {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new Error("Invalid AWS region " + region);
  return `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
}

function emailFromAccessToken(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims === null || typeof claims !== "object" || Array.isArray(claims)) return undefined;
    for (const key of ["email", "preferred_username", "upn"]) {
      const value = (claims as Record<string, unknown>)[key];
      if (typeof value === "string" && /^[^\s@]+@[^\s@]+$/.test(value.trim())) return value.trim();
    }
  } catch {
    // AWS may issue an opaque access token; email is optional in that case.
  }
  return undefined;
}

async function jsonRequest(fetchImpl: FetchLike, url: string, body: unknown, signal?: AbortSignal): Promise<{ response: Response; data: Record<string, unknown> }> {
  return jsonRequestWithHeaders(fetchImpl, url, body, signal);
}

async function jsonRequestWithHeaders(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<{ response: Response; data: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal,
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid response");
      data = parsed as Record<string, unknown>;
    }
    catch {
      const error = new Error("Kiro SSO OIDC returned non-JSON HTTP " + response.status);
      Object.assign(error, { status: response.status });
      throw error;
    }
  }
  return { response, data };
}

function oidcError(stage: string, response: Response, data: Record<string, unknown>): Error {
  const code = typeof data?.error === "string" && [
    "access_denied",
    "authorization_pending",
    "authorization_pending_exception",
    "invalid_client",
    "invalid_grant",
    "invalid_request",
    "slow_down",
    "slow_down_exception",
    "server_error",
    "temporarily_unavailable",
  ].includes(data.error) ? data.error : undefined;
  const suffix = code ? " (" + code + ")" : "";
  return new Error("Kiro " + stage + " failed: HTTP " + response.status + suffix);
}

function refreshedExpiry(expiresIn: number): number {
  const now = Date.now();
  return Math.max(now + 1_000, now + Math.max(1, expiresIn * 1_000 - 60_000));
}

function canReuseCredential(credentials: KiroCredential): boolean {
  return credentials.expires > Date.now();
}

const transientRefreshBackoff = new WeakMap<object, number>();

function reuseAfterTransient(credentials: KiroCredential): boolean {
  if (!canReuseCredential(credentials)) return false;
  const now = Date.now();
  if ((transientRefreshBackoff.get(credentials) ?? 0) > now) return true;
  transientRefreshBackoff.set(credentials, now + 30_000);
  return true;
}

function isTransientRefreshError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return true;
  const status = (error as { status?: unknown }).status;
  return typeof status !== "number" || transientStatus(status);
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function registerClient(
  fetchImpl: FetchLike,
  region: string,
  signal?: AbortSignal,
  issuerUrl = BUILDER_ID_START_URL,
): Promise<RegisterClientResponse> {
  const { response, data } = await jsonRequest(fetchImpl, oidcUrl(region, "/client/register"), {
    clientName: CLIENT_NAME,
    clientType: "public",
    scopes: CODEWHISPERER_SCOPES,
    grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    redirectUris: [],
    issuerUrl,
  }, signal);
  if (!response.ok) throw oidcError("client registration", response, data);
  if (typeof data?.clientId !== "string" || typeof data?.clientSecret !== "string") {
    throw new Error("Kiro client registration returned incomplete credentials");
  }
  return { clientId: data.clientId, clientSecret: data.clientSecret };
}

async function startDeviceAuthorization(
  fetchImpl: FetchLike,
  region: string,
  registration: RegisterClientResponse,
  startUrl: string,
  signal?: AbortSignal,
): Promise<DeviceAuthorizationResponse> {
  const { response, data } = await jsonRequest(fetchImpl, oidcUrl(region, "/device_authorization"), {
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
    startUrl,
  }, signal);
  if (!response.ok) throw oidcError("device authorization", response, data);
  if (typeof data?.deviceCode !== "string" || typeof data?.userCode !== "string" || typeof data?.verificationUri !== "string") {
    throw new Error("Kiro device authorization returned an incomplete response");
  }
  if (typeof data.expiresIn !== "number") throw new Error("Kiro device authorization returned no expiry");
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    verificationUri: data.verificationUri,
    ...(typeof data.verificationUriComplete === "string" ? { verificationUriComplete: data.verificationUriComplete } : {}),
    ...(typeof data.interval === "number" ? { interval: data.interval } : {}),
    expiresIn: data.expiresIn,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("Kiro login cancelled"));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Kiro login cancelled"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

async function pollForToken(
  fetchImpl: FetchLike,
  region: string,
  registration: RegisterClientResponse,
  device: DeviceAuthorizationResponse,
  signal?: AbortSignal,
): Promise<TokenSuccess> {
  const deadline = Date.now() + Math.max(1, device.expiresIn) * 1000;
  let intervalMs = Math.max(0, device.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs, signal);
    if (signal?.aborted) throw new Error("Kiro login cancelled");
    const { response, data } = await jsonRequest(fetchImpl, oidcUrl(region, "/token"), {
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode: device.deviceCode,
    }, signal);
    if (response.ok && typeof data.accessToken === "string" && Number(data.expiresIn) > 0) {
      return {
        accessToken: data.accessToken,
        ...(typeof data.refreshToken === "string" ? { refreshToken: data.refreshToken } : {}),
        expiresIn: Number(data.expiresIn),
      };
    }
    if (response.status === 400 && (data?.error === "authorization_pending" || data?.error === "authorization_pending_exception")) continue;
    if (response.status === 400 && (data?.error === "slow_down" || data?.error === "slow_down_exception")) {
      intervalMs += 5_000;
      continue;
    }
    throw oidcError("device token exchange", response, data);
  }
  throw new Error("Kiro device authorization timed out");
}

async function loginWithBuilderId(
  fetchImpl: FetchLike,
  startUrl: string,
  region: string,
  signal: AbortSignal | undefined,
  callbacks: LoginCallbacks,
): Promise<KiroCredential> {
  callbacks.onProgress?.("Registering Kiro Builder ID device login...");
  const registration = await registerClient(fetchImpl, region, signal, startUrl);
  callbacks.onProgress?.("Requesting Kiro Builder ID authorization code...");
  const device = await startDeviceAuthorization(fetchImpl, region, registration, startUrl, signal);
  callbacks.onAuth?.({
    url: device.verificationUriComplete ?? device.verificationUri,
    instructions: "Approve this Builder ID device login in your browser. Enter code: " + device.userCode,
  });
  callbacks.onProgress?.("Waiting for Kiro Builder ID authorization...");
  const token = await pollForToken(fetchImpl, region, registration, device, signal);
  const email = emailFromAccessToken(token.accessToken);
  return {
    access: token.accessToken,
    refresh: token.refreshToken ?? "",
    expires: Date.now() + Number(token.expiresIn) * 1000,
    ...(email ? { email } : {}),
    kiro: {
      ssoRegion: region,
      apiRegion: region,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      authType: "aws_sso_oidc",
    },
  };
}

export async function refreshKiroCredential(
  credentials: KiroCredential,
  fetchImpl: FetchLike = globalThis.fetch,
  signal?: AbortSignal,
): Promise<KiroCredential> {
  const metadata = credentials.kiro;
  const region = metadata?.ssoRegion ?? DEFAULT_REGION;
  if (!credentials.refresh) {
    throw new Error("Kiro refresh metadata is missing; sign in to Kiro again");
  }
  if (metadata?.authType === "kiro_desktop") {
    let response: { response: Response; data: Record<string, unknown> };
    try {
      response = await jsonRequestWithHeaders(
        fetchImpl,
        desktopRefreshUrl(region),
        { refreshToken: credentials.refresh },
        signal,
        { accept: "application/json", "user-agent": `KiroIDE-1.1.70-${metadata.machineId ?? "unknown"}` },
      );
    } catch (error) {
      if (!signal?.aborted && isTransientRefreshError(error) && reuseAfterTransient(credentials)) return credentials;
      throw error;
    }
    if (!response.response.ok && transientStatus(response.response.status) && reuseAfterTransient(credentials)) return credentials;
    if (!response.response.ok || typeof response.data?.accessToken !== "string" || !Number.isFinite(Number(response.data?.expiresIn ?? 3600)) || Number(response.data?.expiresIn ?? 3600) <= 0) {
      throw oidcError("token refresh", response.response, response.data);
    }
    transientRefreshBackoff.delete(credentials);
    const email = credentials.email ?? emailFromAccessToken(response.data.accessToken);
    return {
      ...credentials,
      access: response.data.accessToken,
      refresh: typeof response.data.refreshToken === "string" && response.data.refreshToken ? response.data.refreshToken : credentials.refresh,
      expires: refreshedExpiry(Number(response.data.expiresIn ?? 3600)),
      ...(email ? { email } : {}),
      kiro: { ...metadata },
    };
  }
  if (!metadata?.clientId || !metadata?.clientSecret) {
    throw new Error("Kiro refresh metadata is missing; sign in to Kiro again");
  }
  let response: Response;
  let data: Record<string, unknown>;
  try {
    const result = await jsonRequest(fetchImpl, oidcUrl(region, "/token"), {
      clientId: metadata.clientId,
      clientSecret: metadata.clientSecret,
      grantType: "refresh_token",
      refreshToken: credentials.refresh,
    }, signal);
    response = result.response;
    data = result.data;
  } catch (error) {
    if (!signal?.aborted && isTransientRefreshError(error) && reuseAfterTransient(credentials)) return credentials;
    throw error;
  }
  if (!response.ok && transientStatus(response.status) && reuseAfterTransient(credentials)) return credentials;
  if (!response.ok || typeof data?.accessToken !== "string" || !Number.isFinite(Number(data?.expiresIn)) || Number(data?.expiresIn) <= 0) {
    throw oidcError("token refresh", response, data);
  }
  transientRefreshBackoff.delete(credentials);
  const email = credentials.email ?? emailFromAccessToken(data.accessToken);
  return {
    ...credentials,
    access: data.accessToken,
    refresh: typeof data.refreshToken === "string" && data.refreshToken ? data.refreshToken : credentials.refresh,
    expires: refreshedExpiry(Number(data.expiresIn)),
    ...(email ? { email } : {}),
    kiro: { ...metadata },
  };
}

export function kiroOAuthProvider() {
  return {
    name: "Kiro",
    async login(callbacks: LoginCallbacks): Promise<KiroCredential> {
      const fetchImpl = callbacks.fetch ?? globalThis.fetch;
      return loginWithKiroBrowser({
        ...callbacks,
        onBuilderId: (details, signal) => loginWithBuilderId(
          fetchImpl,
          details.startUrl,
          details.region,
          signal,
          callbacks,
        ),
      });
    },
    async refreshToken(credentials: KiroCredential, signal?: AbortSignal): Promise<KiroCredential> {
      return refreshKiroCredential(credentials, globalThis.fetch, signal);
    },
    getApiKey(credentials: KiroCredential): string {
      return JSON.stringify({
        version: 1,
        token: credentials.access,
        apiRegion: credentials.kiro?.apiRegion,
        profileArn: credentials.kiro?.profileArn,
        machineId: credentials.kiro?.machineId,
        authType: credentials.kiro?.authType,
      });
    },
  };
}
