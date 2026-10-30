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

### Multiple OAuth accounts

Run `omp login kiro-native` again and sign in with another account to add it to OMP's existing OAuth pool. No separate token file is used.

When a session starts and Kiro accounts are available, the extension asks OMP for the next account in its round-robin sequence and binds the selected credential row to that session. This reservation also happens when another provider is selected: OMP's model cycling authenticates candidates before switching models. With accounts A, B and C, new sessions receive A, B, C, A; subsequent turns keep their assigned account. Existing bindings, resumed sessions, inherited branch bindings and manual account pins are preserved. If no accounts were available at startup, the next Kiro input binds an account unless OMP has already established an affinity.

The round-robin cursor belongs to the running OMP auth storage and resets on restart or pool changes; it is not a machine-wide counter across separate OMP processes. Session bindings are persisted by OMP. Token refresh, account policies, unavailable-account fallback and explicit API-key overrides remain under OMP's control.

## Notes

- Builder ID sends the CLI-shaped request; enterprise credentials with a profile ARN send the IDE-shaped request.
- Kiro's 429 request-rate throttle is retried on the same account up to 3 sends. Monthly quota exhaustion (`MONTHLY_REQUEST_COUNT`) is classified as an OMP usage limit: with OAuth account resolution, OMP temporarily blocks that account, retries the request on an available sibling, and keeps the session bound to the replacement. If every account is exhausted, the request ends with the quota error; credentials are not deleted. A fixed API key has no account pool to rotate through.
- Thinking-only completions are reported as retryable `EmptyResponse` errors so OMP's configured retry/fallback can recover instead of treating them as unclassified failures. Content-filter or guardrail stops that deliver no answer or tool call keep the server's normalized stop reason in the message but are also retryable `EmptyResponse` errors: Kiro trips them on benign turns, and resending the same context recovers.
- Tool pairing matches OMP's built-in providers.
- Kiro reports credits but no token usage, so output tokens are estimated locally with the model's OMP tokenizer to drive the tokens/s readout. Input and cache tokens stay 0, so OMP's cache-hit figure for Kiro is not meaningful.

## Development

```sh
bun test
bun run check
```
