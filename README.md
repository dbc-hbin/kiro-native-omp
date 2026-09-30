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
omp models refresh kiro-native
omp models kiro-native --json
omp --model kiro-native/auto -p 'Reply with OK.'
```

The login uses AWS Builder ID device authorization and stores access/refresh tokens in OMP's OAuth credential store. The request uses only the access token as a Bearer token; Builder ID's service profile ARN is attached **only to the request**, not stored as account metadata. A raw `--api-key` bearer token lacks that Builder ID metadata and may be rejected by models requiring a profile. Kiro `ksk_` API keys are not supported by this OAuth transport.

The provider pre-registers an offline fallback roster using the exact IDs Kiro's `ListAvailableModels` returns (`auto`, `gpt-5.6-*`, `claude-*` up to `claude-opus-5.5`, `claude-sonnet-4`, `deepseek-3.2`, `minimax-*`, `glm-5`, `qwen3-coder-next`). `claude-sonnet-5.5` is also pre-registered ahead of its Kiro release; Kiro rejects it with `INVALID_MODEL_ID` until your account lists it. OpenCodex's other preemptive IDs (`gpt-6-sol`, `gpt-6-luna`) are not pre-registered; discovery adds them once your account can use them. After AWS Builder ID login, OMP queries Kiro's `ListAvailableModels` endpoint and unifies newly discovered models for the authenticated account, caching dynamic models for 24 hours. `omp models refresh kiro-native` forces a new discovery query; `omp models kiro-native --json` shows all selectable IDs. Discovery uses the Builder ID OAuth token and its request-scoped service profile in `us-east-1`; OMP does not pass enterprise profile metadata to the discovery callback, so enterprise-specific discovery is not supported.

Selecting an ID or having it listed in the catalog is not an entitlement guarantee: tier-restricted or newly announced models may be rejected upstream by Kiro until supported by your account and region. The selected ID is sent only as `conversationState.currentMessage.userInputMessage.modelId`; replayed user turns omit `modelId`, and `auto` (or `kiro-auto`) sends `auto`. Account tier, region, and model governance determine which models Kiro accepts. Client-side context and token limits do not guarantee service entitlement.

The pre-registered and newly discovered models offer `low`, `medium`, `high`, `xhigh`, and `max` effort in OMP. If an ID discovered before this update still shows `-` under thinking, run `omp models refresh kiro-native` to replace its cached row. For example, `omp --model kiro-native/auto --thinking high -p 'Reply with OK.'`; select `--thinking off` to omit client effort controls. Kiro-native sends GPT-5.6/GPT-6 effort as `additionalModelRequestFields.reasoning.effort` and Opus 5/5.5 effort as `additionalModelRequestFields.output_config.effort`. GPT-5.6 Terra/Luna at `xhigh` and other models use bounded thinking instructions in the current user message instead; they do not have verified native effort support. `off` does not guarantee Kiro itself will produce no reasoning. The GPT-6 and Opus 5.5 mappings are preemptive, not verified with a currently entitled account.

Requests go to `https://runtime.<apiRegion>.kiro.dev/` with `AmazonCodeWhispererStreamingService.GenerateAssistantResponse` and AWS eventstream responses. Builder ID uses the CLI-shaped request; enterprise credentials with their own profile ARN use the IDE-shaped request. The older `codewhisperer.<region>.amazonaws.com/generateAssistantResponse` route is not used.

CLI headers follow locally captured Kiro CLI 2.26.0 requests, including the user-agent pair, `x-kiro-attempt`, and `accept-encoding: gzip`. The CLI service profile ARN is sent in the body rather than a duplicate header; enterprise IDE profile headers are unchanged. Each logical request keeps its `amz-sdk-invocation-id` across provider retries, and a new request gets a new ID. Data-collection opt-out remains `true`. Unlike the native CLI retry capture, user-agent version tags do not accumulate on retries. Bun can add a transport-generated `Connection` header, so this is not byte-for-byte native transport emulation.

Successful responses retain the outbound conversation ID unless Kiro supplies a valid replacement, so tool-result turns continue even without response metadata. A response containing only reasoning and no answer or tool call is reported as an error, not a completed turn.

Current messages include `userInputMessageContext.envState` with the host operating system and OMP session working directory (`options.cwd`, falling back to `process.cwd()`). Tool-result-only user turns preserve empty `content` instead of adding a carrier instruction. CLI requests retain `agentTaskType: "vibe"` without generating an `agentContinuationId`. Assistant `messageId` values are not synthesized; OMP's `responseId` continues to hold the conversation ID.

Kiro's per-user request-rate throttle (HTTP 429 `ThrottlingException`, e.g. `USER_REQUEST_RATE_EXCEEDED`) is retried inside the provider up to 3 sends, waiting for `Retry-After` or 2s then 4s. A 429 naming an exhausted quota (`MONTHLY_REQUEST_COUNT`), or a server wait longer than OMP's `maxRetryDelayMs` (60s by default), fails immediately so OMP's own retry and model fallback take over.

OMP passes custom providers the raw session history, so the request builder applies the same tool pairing OMP's built-in providers get: every replayed tool call is answered in the next user turn, a call without a result gets an error result (`No result provided`, or `aborted` after an aborted/failed turn), duplicate results are dropped, and a result whose call was compacted away is kept as a `<stale-tool-result>` note. Kiro has no tool-choice field, so `toolChoice: "none"` offers no tools, a named choice offers only that tool, and `any`/`required` offer every tool; forced choices therefore do not fail the request, but the model may still answer without calling a tool.

## Development

```sh
bun test
bun run check
```

`index.ts` registers the provider; `catalog.ts` fetches account models; `oauth.ts` handles device authorization and refresh; `messages.ts` builds model-selected conversation requests; `stream.ts` performs the HTTPS/eventstream exchange; `schema.ts` adapts tool schemas. Tests exercise the transport at a controlled network boundary; `omp-contract.test.ts` drives the provider through OMP's real `registerCustomApi`/`streamSimple` dispatch (`@oh-my-pi/pi-ai`, dev dependency pinned to the installed OMP version) with only the Kiro endpoint replaced. A successful live prompt requires a valid Kiro account and access to the selected model.
