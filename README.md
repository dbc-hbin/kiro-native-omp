# Kiro Native for OMP

OMP provider extension for Kiro's runtime streaming API (`GenerateAssistantResponse`, AWS eventstream), with AWS Builder ID device login. Self-contained: `index.ts` registers the provider, no other checkout needed.

## Install

```sh
bun install
ln -s "$PWD" ~/.omp/agent/extensions/kiro-native
```

Or run directly: `omp -e "$PWD/index.ts"`.

## Sign in and use

```sh
omp login kiro-native
omp models refresh kiro-native
omp --model kiro-native/auto -p 'Reply with OK.'
```

Tokens live in OMP's OAuth store. An offline model roster ships in the provider; after login, `ListAvailableModels` is queried and cached for 24h. Effort is selectable (`low`..`max`) for models that accept it.

## Notes

- Builder ID sends the CLI-shaped request; enterprise credentials with a profile ARN send the IDE-shaped request.
- Kiro's 429 request-rate throttle is retried in-provider up to 3 sends; exhausted quota fails fast so OMP's own retry/fallback takes over.
- Thinking-only completions are reported as retryable `EmptyResponse` errors so OMP's configured retry/fallback can recover instead of treating them as unclassified failures. Explicit content-filter or guardrail stops remain non-retryable.
- Tool pairing matches OMP's built-in providers.
- Kiro reports credits but no token usage, so output tokens are estimated locally with the model's OMP tokenizer to drive the tokens/s readout. Input and cache tokens stay 0, so OMP's cache-hit figure for Kiro is not meaningful.

## Development

```sh
bun test
bun run check
```
