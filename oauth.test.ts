import { expect, test } from "bun:test";
import { refreshKiroCredential } from "./oauth";

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
