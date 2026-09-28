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
    baseUrl: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    api: API_ID,
    authHeader: false,
    oauth: kiroOAuthProvider(),
    streamSimple: (model: ModelLike, context: OmpContext, options: StreamOptionsLike) => streamKiro(model, context, options),
    models: [{
      id: "auto",
      name: "Kiro Auto (AWS Builder ID)",
      api: API_ID,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    }],
  });

  pi.logger.debug("Kiro native provider registered", { provider: PROVIDER_ID, api: API_ID });
}
