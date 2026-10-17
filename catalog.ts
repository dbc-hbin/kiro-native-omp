import { BUILDER_ID_SERVICE_PROFILE_ARN, KIRO_EFFORTS } from "./constants";

const API_ID = "kiro-codewhisperer-stream";
const TARGET = "KiroControlPlaneBearerService.ListAvailableModels";
const MODEL_ID_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Offline fallback until account discovery runs. IDs use the exact spelling
// Kiro's ListAvailableModels returns, so a static row and its discovered row
// merge instead of appearing twice. `claude-sonnet-5.5` is pre-registered ahead
// of Kiro's release; until the account lists it, Kiro rejects it with
// INVALID_MODEL_ID. Other preemptive OpenCodex IDs (gpt-6-*) are omitted;
// discovery adds them once an account can use them.
export const KIRO_SEED_MODELS: ReadonlyArray<readonly [string, string, number]> = [
  ["auto", "Kiro Auto", 200_000],
  ["gpt-5.6-sol", "GPT-5.6 Sol", 1_000_000],
  ["gpt-5.6-terra", "GPT-5.6 Terra", 1_000_000],
  ["gpt-5.6-luna", "GPT-5.6 Luna", 1_000_000],
  ["claude-sonnet-5.5", "Claude Sonnet 5.5", 1_000_000],
  ["claude-sonnet-5", "Claude Sonnet 5", 1_000_000],
  ["claude-opus-5.5", "Claude Opus 5.5", 1_000_000],
  ["claude-opus-5", "Claude Opus 5", 1_000_000],
  ["claude-opus-4.8", "Claude Opus 4.8", 1_000_000],
  ["claude-opus-4.7", "Claude Opus 4.7", 1_000_000],
  ["claude-opus-4.6", "Claude Opus 4.6", 1_000_000],
  ["claude-opus-4.5", "Claude Opus 4.5", 200_000],
  ["claude-sonnet-4.6", "Claude Sonnet 4.6", 1_000_000],
  ["claude-sonnet-4.5", "Claude Sonnet 4.5", 200_000],
  ["claude-sonnet-4", "Claude Sonnet 4", 200_000],
  ["claude-haiku-4.5", "Claude Haiku 4.5", 200_000],
  ["deepseek-3.2", "DeepSeek 3.2", 128_000],
  ["minimax-m2.5", "MiniMax M2.5", 200_000],
  ["minimax-m2.1", "MiniMax M2.1", 200_000],
  ["glm-5", "GLM-5", 200_000],
  ["qwen3-coder-next", "Qwen3 Coder Next", 256_000],
];
const knownModels = new Map(KIRO_SEED_MODELS.map(([id, name, contextWindow]) => [id, { name, contextWindow }]));

export interface KiroModelDefinition {
  id: string;
  name: string;
  api: typeof API_ID;
  reasoning: true;
  thinking: {
    mode: "effort";
    efforts: typeof KIRO_EFFORTS;
  };
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

function discoveryCredentials(apiKey: string | undefined): {
  token: string;
  region: string;
  profileArn?: string;
  machineId?: string;
} {
  const value = apiKey?.trim();
  if (!value || value.startsWith("ksk_")) {
    throw new Error("Kiro model discovery requires an AWS Builder ID OAuth token");
  }
  if (!value.startsWith("{")) {
    return { token: value, region: "us-east-1", profileArn: BUILDER_ID_SERVICE_PROFILE_ARN };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid Kiro OAuth credential envelope");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid Kiro OAuth credential envelope");
  }
  const data = parsed as Record<string, unknown>;
  if (data.version !== 1 || typeof data.token !== "string" || !data.token.trim() || data.token.trim().startsWith("ksk_")) {
    throw new Error("Invalid Kiro OAuth credential envelope");
  }
  const region = data.apiRegion ?? "us-east-1";
  if (typeof region !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
    throw new Error("Invalid Kiro AWS region");
  }
  const profileArn = typeof data.profileArn === "string" && data.profileArn ? data.profileArn : undefined;
  return {
    token: data.token,
    region,
    ...(profileArn ? { profileArn } : {}),
    ...(typeof data.machineId === "string" && data.machineId ? { machineId: data.machineId } : {}),
  };
}

export async function fetchKiroModels(apiKey: string | undefined): Promise<readonly KiroModelDefinition[]> {
  const credentials = discoveryCredentials(apiKey);

  const url = new URL(`https://management.${credentials.region}.kiro.dev/`);
  url.searchParams.set("origin", "AI_EDITOR");
  if (credentials.profileArn) url.searchParams.set("profileArn", credentials.profileArn);
  const ideBuild = credentials.machineId
    ? `KiroIDE-1.1.70-${credentials.machineId}-KAS/0.66.7`
    : undefined;
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${credentials.token}`,
      "content-type": "application/x-amz-json-1.0",
      accept: "application/json",
      "x-amz-target": TARGET,
      "x-amzn-codewhisperer-optout": "true",
      ...(ideBuild ? {
        "user-agent": `aws-sdk-js/1.0.0 ua/2.1 os/win32#10.0.26200 lang/js md/nodejs#24.18.0 api/kirocontrolplanebearer#1.0.0 m/N,E ${ideBuild}`,
        "x-amz-user-agent": `aws-sdk-js/1.0.0 ${ideBuild}`,
      } : {}),
    },
    body: JSON.stringify({
      origin: "AI_EDITOR",
      ...(credentials.profileArn ? { profileArn: credentials.profileArn } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Kiro model discovery failed (HTTP ${response.status})`);

  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models)
    || body.models.length === 0 || body.models.length > 2_000) {
    throw new Error("Kiro model discovery returned an invalid catalog");
  }

  const seen = new Set<string>();
  const models: KiroModelDefinition[] = [];
  for (const row of body.models as unknown[]) {
    if (row === null || typeof row !== "object" || !("modelId" in row)) continue;
    const id = row.modelId;
    if (typeof id !== "string" || !id || id.length > 1_024 || id !== id.trim()
      || MODEL_ID_CONTROL.test(id) || seen.has(id)) continue;
    seen.add(id);
    const limits = "tokenLimits" in row ? row.tokenLimits : undefined;
    const inputLimit = limits !== null && typeof limits === "object" && "maxInputTokens" in limits
      ? limits.maxInputTokens : undefined;
    const outputLimit = limits !== null && typeof limits === "object" && "maxOutputTokens" in limits
      ? limits.maxOutputTokens : undefined;
    const known = knownModels.get(id);
    const contextWindow = typeof inputLimit === "number" && Number.isSafeInteger(inputLimit) && inputLimit > 0
      ? inputLimit : known?.contextWindow ?? 32_000;
    models.push({
      id,
      name: known?.name ?? id,
      api: API_ID,
      reasoning: true,
      thinking: {
        mode: "effort",
        efforts: KIRO_EFFORTS,
      },
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: typeof outputLimit === "number" && Number.isSafeInteger(outputLimit) && outputLimit > 0
        ? Math.min(contextWindow, outputLimit)
        : Math.min(contextWindow, 32_000),
    });
  }
  if (models.length === 0) throw new Error("Kiro model discovery returned no usable models");
  return models;
}
