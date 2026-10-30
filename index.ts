import { fetchKiroModels, KIRO_SEED_MODELS } from "./catalog";
import { KIRO_EFFORTS } from "./constants";
import { kiroOAuthProvider } from "./oauth";
import { streamKiro } from "./stream";
import type { ModelLike, OmpContext, StreamOptionsLike } from "./types";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

interface SessionContext {
  sessionManager: { getSessionId(): string };
  modelRegistry: { authStorage: AuthStorage };
  model?: ModelLike & { baseUrl?: string };
}

interface ExtensionApi {
  setLabel(label: string): void;
  registerProvider(id: string, config: unknown): void;
  on(event: "session_start" | "session_switch" | "session_branch" | "input",
    handler: (event: { type: string }, ctx: SessionContext) => Promise<void>): void;
  logger: { debug(message: string, details: Record<string, string>): void };
}

const API_ID = "kiro-codewhisperer-stream";
const PROVIDER_ID = "kiro-native";
const assignments = new WeakMap<AuthStorage, Map<string, Promise<void>>>();

async function bindSession(event: { type: string }, ctx: SessionContext): Promise<void> {
  if (event.type === "input" && ctx.model?.provider !== PROVIDER_ID) return;
  const model = ctx.model?.provider === PROVIDER_ID ? ctx.model : undefined;
  const auth = ctx.modelRegistry.authStorage;
  const sessionId = ctx.sessionManager.getSessionId();
  const accounts = auth.oauth.accounts(PROVIDER_ID, sessionId);
  if (!sessionId || accounts.length === 0 || accounts.some(account => account.active)) return;

  let pending = assignments.get(auth);
  if (!pending) assignments.set(auth, pending = new Map());
  const existing = pending.get(sessionId);
  if (existing) return existing;

  const assignment = (async () => {
    // OMP hashes named sessions, but uses round robin without a session ID.
    // Resolve through its normal policy/refresh path, then persist automatic
    // affinity by row ID so subsequent turns and resumes keep that account.
    const selected = await auth.keys.getWithCredential(PROVIDER_ID, undefined, {
      modelId: model?.id,
      baseUrl: model?.baseUrl,
    });
    if (selected?.credentialId !== undefined &&
        !auth.oauth.accounts(PROVIDER_ID, sessionId).some(account => account.active)) {
      auth.sessions.pin(PROVIDER_ID, sessionId, selected.credentialId, { restoredAtMs: Date.now() });
    }
  })();
  pending.set(sessionId, assignment);
  try {
    await assignment;
  } finally {
    pending.delete(sessionId);
  }
}

export default function kiroNativeExtension(pi: ExtensionApi): void {
  pi.setLabel("Kiro Native");
  // Model cycling authenticates candidates before changing ctx.model. Reserve
  // a Kiro account at session creation even when another provider is selected.
  pi.on("session_start", bindSession);
  pi.on("session_switch", bindSession);
  pi.on("session_branch", bindSession);
  // Input precedes OMP's API-key preflight, including after /login or /model.
  pi.on("input", bindSession);

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "https://runtime.us-east-1.kiro.dev/",
    api: API_ID,
    authHeader: false,
    oauth: kiroOAuthProvider(),
    fetchDynamicModels: fetchKiroModels,
    streamSimple: (model: ModelLike, context: OmpContext, options: StreamOptionsLike) => streamKiro(model, context, options),
    models: KIRO_SEED_MODELS.map(([id, name, contextWindow]) => ({
      id,
      name,
      api: API_ID,
      reasoning: true,
      thinking: {
        mode: "effort",
        efforts: KIRO_EFFORTS,
      },
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: 32_000,
    })),
  });

  pi.logger.debug("Kiro native provider registered", { provider: PROVIDER_ID, api: API_ID });
}
