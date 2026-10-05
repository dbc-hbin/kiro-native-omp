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
- Tool pairing matches OMP's built-in providers.

## Development

```sh
bun test
bun run check
```
