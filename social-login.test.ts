import { describe, expect, test } from "bun:test";
import { exchangeRedirectUri, loginWithKiroBrowser, loginWithSocialProvider } from "./social-login";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function callbackUrl(authUrl: string, provider: "google" | "github", code = "one-time-code"): string {
  const auth = new URL(authUrl);
  const callback = new URL("http://127.0.0.1:3128/oauth/callback");
  callback.searchParams.set("state", auth.searchParams.get("state")!);
  callback.searchParams.set("login_option", provider);
  callback.searchParams.set("code", code);
  return callback.toString();
}

describe("Kiro social browser login", () => {
  test("builds Google PKCE URL and exchanges one callback", async () => {
    let authUrl = "";
    let body: Record<string, string> | undefined;
    const ready = deferred<void>();
    const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token");
      body = JSON.parse(String(init?.body)) as Record<string, string>;
      return new Response(JSON.stringify({
        accessToken: "access-value",
        refreshToken: "refresh-value",
        expiresIn: 3600,
        profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/social",
        machineId: "machine-from-server",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }, { preconnect: globalThis.fetch.preconnect });

    const login = loginWithSocialProvider("google", {
      fetch: fetchImpl,
      onAuth(info) {
        authUrl = info.url;
        ready.resolve();
      },
    });
    await ready.promise;
    const auth = new URL(authUrl);
    expect(auth.pathname).toBe("/signin");
    expect(auth.searchParams.get("redirect_uri")).toBe("http://localhost:3128");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("signin_methods")).toBe("google");
    const response = await fetch(callbackUrl(authUrl, "google"));
    expect(response.status).toBe(200);
    const credentials = await login;
    expect(body?.redirect_uri).toBe(exchangeRedirectUri("google"));
    expect(body?.code_verifier).toBeTruthy();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body!.code_verifier));
    const expectedChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(auth.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(credentials.kiro).toMatchObject({
      authType: "kiro_desktop",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/social",
      machineId: "machine-from-server",
    });
  });

  test("one Kiro browser login leaves provider choice to app.kiro.dev", async () => {
    let authUrl = "";
    const ready = deferred<void>();
    const fetchImpl = Object.assign(async () => new Response(JSON.stringify({
      accessToken: "access-value",
      refreshToken: "refresh-value",
      expiresIn: 3600,
    }), { status: 200 }), { preconnect: globalThis.fetch.preconnect });
    const login = loginWithKiroBrowser({
      fetch: fetchImpl,
      onAuth(info) {
        authUrl = info.url;
        ready.resolve();
      },
    });
    await ready.promise;
    const auth = new URL(authUrl);
    expect(auth.searchParams.get("signin_methods")).toBeNull();
    expect((await fetch(callbackUrl(authUrl, "google", "chosen-by-web"))).status).toBe(200);
    expect((await login).access).toBe("access-value");
  });

  test("Builder ID signin callback enters the device login handoff", async () => {
    let authUrl = "";
    const ready = deferred<void>();
    const login = loginWithKiroBrowser({
      onAuth(info) {
        authUrl = info.url;
        ready.resolve();
      },
      onBuilderId: async (details) => {
        expect(details.startUrl).toBe("https://view.awsapps.com/start/");
        expect(details.region).toBe("us-east-1");
        return {
          access: "builder-access",
          refresh: "builder-refresh",
          expires: Date.now() + 3_600_000,
          kiro: { authType: "aws_sso_oidc", apiRegion: details.region },
        };
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
    expect((await login).access).toBe("builder-access");
  });

  test("rejects wrong state and provider before accepting the callback", async () => {
    let authUrl = "";
    const ready = deferred<void>();
    const fetchImpl = Object.assign(async () => new Response(JSON.stringify({
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 3600,
    }), { status: 200 }), { preconnect: globalThis.fetch.preconnect });
    const login = loginWithSocialProvider("github", {
      fetch: fetchImpl,
      onAuth(info) {
        authUrl = info.url;
        ready.resolve();
      },
    });
    await ready.promise;
    const wrongState = new URL(callbackUrl(authUrl, "github"));
    wrongState.searchParams.set("state", "wrong-state");
    expect((await fetch(wrongState)).status).toBe(400);
    const wrongProvider = new URL(callbackUrl(authUrl, "google"));
    expect((await fetch(wrongProvider)).status).toBe(400);
    expect((await fetch(callbackUrl(authUrl, "github"))).status).toBe(200);
    await login;
  });

  test("claims a callback before exchange so duplicate callbacks exchange once", async () => {
    let authUrl = "";
    let exchangeCount = 0;
    const ready = deferred<void>();
    const exchangeStarted = deferred<void>();
    const releaseExchange = deferred<void>();
    const fetchImpl = Object.assign(async () => {
      exchangeCount += 1;
      exchangeStarted.resolve();
      await releaseExchange.promise;
      return new Response(JSON.stringify({ accessToken: "a", refreshToken: "r", expiresIn: 3600 }), { status: 200 });
    }, { preconnect: globalThis.fetch.preconnect });
    const login = loginWithSocialProvider("google", {
      fetch: fetchImpl,
      onAuth(info) {
        authUrl = info.url;
        ready.resolve();
      },
    });
    await ready.promise;
    const callback = callbackUrl(authUrl, "google");
    const first = fetch(callback);
    await exchangeStarted.promise;
    const duplicate = await fetch(callback);
    expect(duplicate.status).toBe(409);
    releaseExchange.resolve();
    expect((await first).status).toBe(200);
    await login;
    expect(exchangeCount).toBe(1);
  });

  test("uses manual callback input when port 3128 is occupied", async () => {
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 3128, fetch: () => new Response("occupied") });
    let occupiedIpv6: ReturnType<typeof Bun.serve> | undefined;
    try {
      occupiedIpv6 = Bun.serve({ hostname: "::1", port: 3128, fetch: () => new Response("occupied") });
    } catch {}
    let authUrl = "";
    const ready = deferred<void>();
    const fetchImpl = Object.assign(async () => new Response(JSON.stringify({
      accessToken: "a",
      refreshToken: "r",
      expiresIn: 3600,
    }), { status: 200 }), { preconnect: globalThis.fetch.preconnect });
    try {
      const login = loginWithSocialProvider("github", {
        fetch: fetchImpl,
        onAuth(info) {
          authUrl = info.url;
          ready.resolve();
        },
        onManualCodeInput: async () => {
          await ready.promise;
          return "a=b";
        },
      });
      await ready.promise;
      const credentials = await login;
      expect(credentials.access).toBe("a");
    } finally {
      occupied.stop(true);
      occupiedIpv6?.stop(true);
    }
  });

  test("cancellation stops the loopback listener", async () => {
    const controller = new AbortController();
    const ready = deferred<void>();
    const login = loginWithSocialProvider("google", {
      signal: controller.signal,
      onAuth() { ready.resolve(); },
    });
    await ready.promise;
    controller.abort();
    await expect(login).rejects.toThrow("cancelled");
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 3128, fetch: () => new Response("probe") });
    probe.stop(true);
  });
});
