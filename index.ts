import { fetchKiroModels, KIRO_SEED_MODELS } from "./catalog";
import { KIRO_EFFORTS } from "./constants";
import { kiroOAuthProvider } from "./oauth";
import { streamKiro } from "./stream";
import type { ModelLike, OmpContext, StreamOptionsLike } from "./types";

interface ExtensionApi {
  setLabel(label: string): void;
  registerProvider(id: string, config: unknown): void;
  logger: { debug(message: string, details: Record<string, string>): void };
}

const API_ID = "kiro-codewhisperer-stream";
const PROVIDER_ID = "kiro-native";

export default function kiroNativeExtension(pi: ExtensionApi): void {
  pi.setLabel("Kiro Native");

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
