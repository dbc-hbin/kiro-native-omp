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

const KIRO_MODELS: ReadonlyArray<readonly [string, string, number]> = [
  ["auto", "Kiro Auto", 200_000],
  ["gpt-5.6-sol", "GPT-5.6 Sol", 1_000_000],
  ["gpt-5.6-terra", "GPT-5.6 Terra", 1_000_000],
  ["gpt-5.6-luna", "GPT-5.6 Luna", 1_000_000],
  ["claude-sonnet-5", "Claude Sonnet 5", 1_000_000],
  ["claude-opus-5", "Claude Opus 5", 1_000_000],
  ["claude-opus-4.8", "Claude Opus 4.8", 1_000_000],
  ["claude-opus-4.7", "Claude Opus 4.7", 1_000_000],
  ["claude-opus-4.6", "Claude Opus 4.6", 1_000_000],
  ["claude-opus-4.5", "Claude Opus 4.5", 200_000],
  ["claude-sonnet-4.6", "Claude Sonnet 4.6", 1_000_000],
  ["claude-sonnet-4.5", "Claude Sonnet 4.5", 200_000],
  ["claude-sonnet-4.0", "Claude Sonnet 4.0", 200_000],
  ["claude-haiku-4.5", "Claude Haiku 4.5", 200_000],
  ["deepseek-3.2", "DeepSeek 3.2", 128_000],
  ["minimax-m2.5", "MiniMax M2.5", 200_000],
  ["minimax-m2.1", "MiniMax M2.1", 200_000],
  ["glm-5", "GLM-5", 200_000],
  ["qwen3-coder-next", "Qwen3 Coder Next", 256_000],
];

export default function kiroNativeExtension(pi: ExtensionApi): void {
  pi.setLabel("Kiro Native");

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "https://runtime.us-east-1.kiro.dev/",
    api: API_ID,
    authHeader: false,
    oauth: kiroOAuthProvider(),
    streamSimple: (model: ModelLike, context: OmpContext, options: StreamOptionsLike) => streamKiro(model, context, options),
    models: KIRO_MODELS.map(([id, name, contextWindow]) => ({
      id,
      name,
      api: API_ID,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: 32_000,
    })),
  });

  pi.logger.debug("Kiro native provider registered", { provider: PROVIDER_ID, api: API_ID });
}
