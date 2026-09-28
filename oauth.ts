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
  onAuth?: (details: { url: string; instructions: string }) => void;
}

function oidcUrl(region: string, path: string): string {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new Error("Invalid AWS region " + region);
  return "https://oidc." + region + ".amazonaws.com" + path;
}

async function jsonRequest(fetchImpl: FetchLike, url: string, body: unknown, signal?: AbortSignal): Promise<{ response: Response; data: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
    catch { throw new Error("Kiro SSO OIDC returned non-JSON HTTP " + response.status); }
  }
  return { response, data };
}

function oidcError(stage: string, response: Response, data: Record<string, unknown>): Error {
  const code = typeof data?.error === "string" ? data.error : undefined;
  const description = typeof data?.error_description === "string" ? data.error_description : undefined;
  const suffix = [code, description].filter(Boolean).join(": ");
  return new Error("Kiro " + stage + " failed: HTTP " + response.status + (suffix ? " (" + suffix + ")" : ""));
}

async function registerClient(fetchImpl: FetchLike, region: string, signal?: AbortSignal): Promise<RegisterClientResponse> {
  const { response, data } = await jsonRequest(fetchImpl, oidcUrl(region, "/client/register"), {
    clientName: CLIENT_NAME,
    clientType: "public",
    scopes: CODEWHISPERER_SCOPES,
    grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    redirectUris: [],
    issuerUrl: BUILDER_ID_START_URL,
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
  signal?: AbortSignal,
): Promise<DeviceAuthorizationResponse> {
  const { response, data } = await jsonRequest(fetchImpl, oidcUrl(region, "/device_authorization"), {
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
    startUrl: BUILDER_ID_START_URL,
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

export async function refreshKiroCredential(
  credentials: KiroCredential,
  fetchImpl: FetchLike = globalThis.fetch,
  signal?: AbortSignal,
): Promise<KiroCredential> {
  const metadata = credentials.kiro;
  const region = metadata?.ssoRegion ?? DEFAULT_REGION;
  if (!credentials.refresh || !metadata?.clientId || !metadata?.clientSecret) {
    throw new Error("Kiro refresh metadata is missing; sign in to Kiro again");
  }
  const { response, data } = await jsonRequest(fetchImpl, oidcUrl(region, "/token"), {
    clientId: metadata.clientId,
    clientSecret: metadata.clientSecret,
    grantType: "refresh_token",
    refreshToken: credentials.refresh,
  }, signal);
  if (!response.ok || typeof data?.accessToken !== "string" || Number(data?.expiresIn) <= 0) {
    throw oidcError("token refresh", response, data);
  }
  return {
    ...credentials,
    access: data.accessToken,
    refresh: typeof data.refreshToken === "string" && data.refreshToken ? data.refreshToken : credentials.refresh,
    expires: Date.now() + Number(data.expiresIn) * 1000,
    kiro: { ...metadata },
  };
}

export function kiroOAuthProvider() {
  return {
    name: "Kiro (AWS Builder ID)",
    async login(callbacks: LoginCallbacks): Promise<KiroCredential> {
      const fetchImpl = callbacks?.fetch ?? globalThis.fetch;
      const signal = callbacks?.signal;
      const region = DEFAULT_REGION;
      callbacks?.onProgress?.("Registering Kiro device login...");
      const registration = await registerClient(fetchImpl, region, signal);
      callbacks?.onProgress?.("Requesting Kiro authorization code...");
      const device = await startDeviceAuthorization(fetchImpl, region, registration, signal);
      callbacks?.onAuth?.({
        url: device.verificationUriComplete ?? device.verificationUri,
        instructions: "Enter code: " + device.userCode,
      });
      callbacks?.onProgress?.("Waiting for Kiro authorization...");
      const token = await pollForToken(fetchImpl, region, registration, device, signal);
      return {
        access: token.accessToken,
        refresh: token.refreshToken ?? "",
        expires: Date.now() + Number(token.expiresIn) * 1000,
        kiro: {
          ssoRegion: region,
          apiRegion: region,
          clientId: registration.clientId,
          clientSecret: registration.clientSecret,
          authType: "aws_sso_oidc",
        },
      };
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
        authType: credentials.kiro?.authType,
      });
    },
  };
}
