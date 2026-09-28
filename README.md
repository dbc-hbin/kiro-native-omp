# Kiro Native for OMP

Standalone OMP provider extension for Kiro's regional runtime streaming API. Source and tests live in this repository; no import from another checkout is required. Bun is required for the extension and tests.

## Install

```sh
cd ~/Documents/kiro-native-omp
bun install
ln -s "$PWD" ~/.omp/agent/extensions/kiro-native
```

OMP discovers `index.ts` through the linked directory. If that extension directory already exists, move its contents into this repository before creating the link; do not enable two copies of the provider. Alternatively, run with `omp -e "$PWD/index.ts"` without automatic discovery.

## Sign in and use

```sh
omp login kiro-native
omp --model kiro-native/auto -p 'Reply with OK.'
omp --model kiro-native/gpt-5.6-sol -p 'Reply with OK.'
```

The login uses AWS Builder ID device authorization and stores access/refresh tokens in OMP's OAuth credential store. The request uses only the access token as a Bearer token; Builder ID's service profile ARN is attached **only to the request**, not stored as account metadata. A raw `--api-key` bearer token lacks that Builder ID metadata and may be rejected by models requiring a profile. Kiro `ksk_` API keys are not supported by this OAuth transport.

The extension registers Auto and released Kiro model IDs from the published model catalog. The selected ID is sent as `conversationState.currentMessage.userInputMessage.modelId` (and on replayed user turns); Auto sends `auto`. Account tier, region, and model governance still determine which models Kiro accepts. GPT-5.6 availability is experimental and region/tier limited. Client-side context/output limits do not guarantee service entitlement.

Requests go to `https://runtime.<apiRegion>.kiro.dev/` with `AmazonCodeWhispererStreamingService.GenerateAssistantResponse` and AWS eventstream responses. Builder ID uses the CLI-shaped request; enterprise credentials with their own profile ARN use the IDE-shaped request. The older `codewhisperer.<region>.amazonaws.com/generateAssistantResponse` route is not used.

Successful responses retain the outbound conversation ID unless Kiro supplies a valid replacement, so tool-result turns continue even without response metadata. A response containing only reasoning and no answer or tool call is reported as an error, not a completed turn.

## Development

```sh
bun test
bun run check
```

`index.ts` registers models; `oauth.ts` handles device authorization and refresh; `messages.ts` builds model-selected conversation requests; `stream.ts` performs the HTTPS/eventstream exchange; `schema.ts` adapts tool schemas. Tests exercise the transport at a controlled network boundary. A successful live prompt requires a valid Kiro account and access to the selected model. OMP's `models` catalog command may not list extension-provided models even when `--model kiro-native/<id>` loads them.
