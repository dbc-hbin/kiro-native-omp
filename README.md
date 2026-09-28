# Kiro Native for OMP

Standalone OMP provider extension for Kiro's AWS Builder ID / CodeWhisperer streaming endpoint. Source and tests live in this repository; no import from another checkout is required. Bun is required for the extension and tests.

## Install

```sh
cd ~/Documents/kiro-native-omp
bun install
ln -s "$PWD" ~/.omp/agent/extensions/kiro-native
omp models kiro-native
```

OMP discovers `index.ts` through the linked directory. If the extension directory already exists, move its contents into this repository before creating the link; do not leave two copies of the provider enabled. Alternatively, run with `omp -e "$PWD/index.ts"` without automatic discovery.

## Sign in and use

```sh
omp login kiro-native
omp --model kiro-native/auto -p 'Reply with OK.'
```

The login uses AWS Builder ID's device authorization flow and stores the access/refresh token through OMP's OAuth credential store. `streamSimple` receives the access token and the API region/profile ARN encoded by the OAuth provider; only the access token is sent as a Bearer token. For an existing SSO bearer token, OMP's `--api-key` may supply it directly. This AWS CodeWhisperer request schema has no per-request model selector, so the extension exposes one `auto` model instead of advertising GPT/Claude variants it cannot select. Its context/output limits are conservative client-side caps, not a service capability guarantee. This extension does **not** implement Kiro `ksk_` API-key authentication; that is a different endpoint/protocol. Never put credentials in this repository.

## Development

```sh
bun test
bun run check
omp models kiro-native
```

`index.ts` registers the provider, `oauth.ts` implements device authorization and refresh, `messages.ts` builds the CodeWhisperer request, `stream.ts` performs the HTTPS/eventstream exchange, and `schema.ts` adapts OMP tool schemas. HTTP transport tests use a controlled fetch response; registration can be checked without credentials, while a live prompt requires a valid Kiro account and service access. The AWS endpoint is `/generateAssistantResponse` and its request/event shapes follow the generated CodeWhisperer streaming client, not the older root-path RPC.
