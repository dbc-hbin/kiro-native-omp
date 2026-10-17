import { expect, test } from "bun:test";
import { kiroOAuthProvider, refreshKiroCredential } from "./oauth";

test("social refresh uses Kiro Desktop refresh and preserves metadata", async () => {
  let requestUrl = "";
  let requestBody = "";
  let requestHeaders: Headers | undefined;
  const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, { preconnect: globalThis.fetch.preconnect });
  const original = {
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() + 120_000,
    kiro: {
      authType: "kiro_desktop" as const,
      apiRegion: "us-east-1",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/social",
      machineId: "machine-1",
    },
  };
  const refreshed = await refreshKiroCredential(original, fetchImpl);
  expect(requestUrl).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
  expect(requestBody).toBe(JSON.stringify({ refreshToken: "old-refresh" }));
  expect(requestHeaders?.get("user-agent")).toBe("KiroIDE-1.1.70-machine-1");
  expect(refreshed.kiro).toEqual(original.kiro);
  expect(refreshed.expires).toBeGreaterThan(Date.now());
  expect(refreshed.expires).toBeLessThan(Date.now() + 3600_000);
});

test("an unexpired credential survives a transient refresh failure", async () => {
  const original = {
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() + 120_000,
    kiro: { authType: "kiro_desktop" as const, machineId: "machine-1" },
  };
  const fetchImpl = Object.assign(async () => new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 }), {
    preconnect: globalThis.fetch.preconnect,
  });
  await expect(refreshKiroCredential(original, fetchImpl)).resolves.toBe(original);
  await expect(refreshKiroCredential(original, fetchImpl)).resolves.toBe(original);
});

test("unified Builder ID callback completes the AWS OIDC device flow", async () => {
  let authUrl = "";
  const ready = Promise.withResolvers<void>();
  const responses = [
    new Response(JSON.stringify({ clientId: "client", clientSecret: "secret" }), { status: 200 }),
    new Response(JSON.stringify({
      deviceCode: "device",
      userCode: "ABCD-EFGH",
      verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
      verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
      interval: 0,
      expiresIn: 60,
    }), { status: 200 }),
    new Response(JSON.stringify({
      accessToken: `header.${Buffer.from(JSON.stringify({ email: "builder@example.com" })).toString("base64url")}.signature`,
      refreshToken: "builder-refresh",
      expiresIn: 3600,
    }), { status: 200 }),
  ];
  const fetchImpl = Object.assign(async () => responses.shift()!, { preconnect: globalThis.fetch.preconnect });
  const login = kiroOAuthProvider().login({
    fetch: fetchImpl,
    onAuth(info) {
      if (!authUrl) {
        authUrl = info.url;
        ready.resolve();
      }
    },
  });
  await ready.promise;
  const auth = new URL(authUrl);
  const callback = new URL("http://127.0.0.1:3128/signin/callback");
  callback.searchParams.set("state", auth.searchParams.get("state")!);
  callback.searchParams.set("login_option", "builderid");
  callback.searchParams.set("issuer_url", "https://view.awsapps.com/start/");
  callback.searchParams.set("idc_region", "us-east-1");
  expect((await fetch(callback)).status).toBe(200);
  const credentials = await login;
  expect(credentials.access).toContain("header.");
  expect(credentials.email).toBe("builder@example.com");
  expect(credentials.kiro?.authType).toBe("aws_sso_oidc");
});
