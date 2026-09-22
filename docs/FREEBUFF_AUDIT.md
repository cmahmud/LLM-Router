---
title: "LLM-Router: FreeBuff Source Audit"
lastUpdated: 2026-09-22
---

# Source audit — 2026-09-22 UTC

This is a source-level audit. No authenticated FreeBuff inference, client conformance run, or
reference-project test suite was executed. Observed code, inferred consequences and proposed
changes are distinguished below. A source implementation is not proof of live compatibility.

## Revisions and methodology

GitHub MCP retrieved repository metadata, refs, recursive trees, source files, releases, search
results and relevant issue state. A pinned public baseline archive on the VPS supported an
exhaustive case-insensitive content search because GitHub code search returned incomplete results.
No source branch was changed during inspection. Source links below are revision-pinned.

| Repository                                                                                                          | Inspected revision                                  | Main source areas                                                                                  | License observed                                    |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [cmahmud/LLM-Router](https://github.com/cmahmud/LLM-Router/tree/3ee283bb944d6d62cc219f74317d5186942e1780)           | `3ee283bb944d6d62cc219f74317d5186942e1780`          | Native provider; executor; validation; shared routes/translators/catalog/resilience                | MIT, diegosouzapw                                   |
| [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute/tree/3ee283bb944d6d62cc219f74317d5186942e1780)   | same baseline                                       | release branch/ref equality; latest releases; base-green issue                                     | MIT, inherited baseline                             |
| [trefeon/freebucks-proxy](https://github.com/trefeon/freebucks-proxy/tree/212883c11f014e050318237b09ca6fde15ae4782) | `212883c11f014e050318237b09ca6fde15ae4782` (Sep 21) | Go session, pool/bridge, registry, transport, Responses, Anthropic, conversion, release targets    | MIT, trefeon                                        |
| [lza6/Freebuff-2API](https://github.com/lza6/Freebuff-2API/tree/bd607aac70548b80f586c60f819ed8e47240e25f)           | `bd607aac70548b80f586c60f819ed8e47240e25f` (Sep 19) | Rust/Axum API, session, upstream, pool, retry, semaphore, SSE protocols                            | MIT, notice names Quorinex                          |
| [chenjh16/freebuff2api](https://github.com/chenjh16/freebuff2api/tree/3ffd5091c3bf064ec69b2c3226965d2c00750133)     | `3ffd5091c3bf064ec69b2c3226965d2c00750133` (Aug 8)  | TypeScript login/session/run/models/upstream/handler; unit and agentic-test material               | MIT, chenjh16                                       |
| [Quorinex/Freebuff2API](https://github.com/Quorinex/Freebuff2API/tree/a1c10357098f0615a8b605bf32ed9455e33320e4)     | `a1c10357098f0615a8b605bf32ed9455e33320e4` (Apr 22) | Go free_session, run_manager, models                                                               | MIT, Quorinex                                       |
| [fatmuh/freebuff-proxy](https://github.com/fatmuh/freebuff-proxy/tree/92d57daf2419afa82891e94deaa3b1af5f2ce7ba)     | `92d57daf2419afa82891e94deaa3b1af5f2ce7ba` (Aug 13) | TypeScript model pools, run/session management, upstream/auth, chat/Responses routes               | No LICENSE found in complete tree; do not copy code |
| [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff/tree/29cb7f7aaef37343a45b0cd7d79acb721919dc16)         | `29cb7f7aaef37343a45b0cd7d79acb721919dc16` (Sep 22) | Official client session API, model/root constants, SDK database, login, foreign-client enforcement | Apache-2.0                                          |

The official repository is the additional materially useful reference: it resolves disagreements
between proxy implementations. GitHub searches `freebuff` and `freebuff proxy pushed:>=2026-09-01`
also returned worker deployments, forks and wrappers. None was established as a superior reference
by this bounded audit; this is not an exhaustive ranking or a claim that no better project exists.

Upstream latest published semver release observed: v3.8.50 (Aug 26); both development branch tips
were still the stated baseline. Open [base-red issue #13866](https://github.com/diegosouzapw/OmniRoute/issues/13866)
reports inherited docs/env synchronization trouble at another push range. It is not proof that this
specific baseline has the same failure. Do not fix unrelated inherited defects in FreeBuff packets.

## Native executor audit

Primary file: [open-sse/executors/freebuff.ts](https://github.com/cmahmud/LLM-Router/blob/3ee283bb944d6d62cc219f74317d5186942e1780/open-sse/executors/freebuff.ts).
The entire executor, registry and five-test provider test file were inspected.

| Priority / location        | Observed behavior                                                            | Consequence / required acceptance                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P0 `execute`, session POST | Uses legacy `/freebuff/session`; official client uses dedicated admission    | Implement verified admission; no silent unsafe fallback                                                             |
| P0 session JSON            | Any 2xx accepted; only reads optional `instanceId`                           | Queued/denied/malformed state can proceed to a run with empty/invalid instance; require active discriminant         |
| P0 run START               | Non-OK ignored; thrown errors swallowed; empty run ID allowed                | Fail before completion dispatch and clean any acquired lease                                                        |
| P0 `codebuff_metadata`     | Client metadata spread after server-owned run/session/cost fields            | Caller can overwrite reserved metadata; reject/strip reserved values and build final server fields last             |
| P0 FINISH                  | Fired as soon as fetch resolves headers, status always completed             | Streaming body still active; finish only after terminal consumption, track failure/cancel honestly                  |
| P0 cleanup                 | Chat fetch rejection bypasses FINISH; cleanup errors swallowed               | Resource ownership must be in one finalizer and bounded cleanup diagnostics                                         |
| P0 errors                  | Raw upstream session text and exception messages returned                    | Use existing sanitization; cap body reads; never echo upstream secrets                                              |
| P1 lifecycle               | New session and client ID per request; no GET/DELETE/reconciliation          | Admission churn, model-lock and concurrent-instance hazards; scoped reuse with ownership                            |
| P1 timeouts                | Uses incoming signal only; cleanup lacks any timeout                         | Add separate header/body/idle/cleanup limits; preserve caller abort semantics                                       |
| P1 retries                 | Overrides BaseExecutor.execute entirely and uses direct fetch                | Cannot assume base executor retries, proxy configuration or transport policies apply                                |
| P1 model mapping           | Nine hard-coded mappings, unknown model defaults to `base2-free`             | Unknown/retired models need deterministic rejection; no helper/default-agent guessing                               |
| P1 platform                | Session/run UA hard-coded `darwin-arm64`                                     | Linux deployment must use honest, verified client metadata; never spoof OS to defeat checks                         |
| P1 prompt                  | Prepends Buffy system identity; weak startsWith detection                    | Mutates caller instructions and interacts with intentional upstream client gates; resolve authorized contract first |
| P1 request shape           | Spreads arbitrary payload, filters message objects without schema validation | Preserve valid content/tools, reject unsupported structures and internal metadata consistently                      |
| P1 streaming               | Returns raw response; no provider terminal/lifetime observation              | Existing generic SSE handling may work, but FreeBuff cleanup is not tied to it                                      |
| P1 usage                   | Reports totalSteps=1 and credits=0 before observing completion               | No evidence of successful step/actual usage; record truthfully per verified upstream schema                         |
| P2 diagnostics             | No provider session/catalog health state                                     | Add low-cardinality, sanitized internal state using shared monitoring                                               |

Registry: [freebuff/index.ts](https://github.com/cmahmud/LLM-Router/blob/3ee283bb944d6d62cc219f74317d5186942e1780/open-sse/config/providers/registry/freebuff/index.ts)
has nine static models, all with contextLength 131,072, and unverified reasoning/vision flags.
Official source now has additional model/root variants and retired/surface-specific entries.
Do not simply expand the hard-coded table.

Validation: [validation.ts](https://github.com/cmahmud/LLM-Router/blob/3ee283bb944d6d62cc219f74317d5186942e1780/src/lib/providers/validation.ts)
`validateFreebuffProvider` POSTs a DeepSeek session to check a token, accepts every 409 as valid,
and conflates every 403 with invalid/expired credentials. This is a mutating health check with
incorrect classification. UI gateway hints also mention an automated harvester; replace with
legitimate authentication guidance during the scoped auth packet.

Tests: [freebuff-provider.test.ts](https://github.com/cmahmud/LLM-Router/blob/3ee283bb944d6d62cc219f74317d5186942e1780/tests/unit/freebuff-provider.test.ts)
contains five checks: constructor, empty credential 401, static registry, gateway metadata, empty
validation token. None exercises a successful upstream exchange, lifecycle, tools, streaming,
cancellation, Responses or Anthropic through OmniRoute.

## What OmniRoute already solves

| Existing area                                                                                           | Reuse and boundary                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/api/v1/{responses,messages}/route.ts`                                                          | Both delegate to shared chat handling; existing admission and early keepalives                                                  |
| `src/sse/handlers/chat.ts`, `open-sse/handlers/chatCore.ts`                                             | Routing, credential selection, translation, execution and response handling                                                     |
| `open-sse/translator/request/openai-responses.ts`                                                       | Instructions, input content, functions/results, tool choices, images and reasoning conversion; has explicit background handling |
| `open-sse/translator/response/openai-responses.ts`, `open-sse/transformer/responsesTransformer.ts`      | Responses events, tool arguments, output items and usage; still need route-level negative EOF/error tests                       |
| `open-sse/translator/request/claude-to-openai.ts`, `response/openai-to-claude.ts`                       | Existing Anthropic path; no second implementation                                                                               |
| `open-sse/handlers/chatCore/{requestSetup,targetFormat,providerExecutionPipeline,streamingPipeline}.ts` | Wire-format metadata, failure and stream pipeline; avoid assumptions about inherited BaseExecutor behavior                      |
| `src/sse/services/auth.ts`, `open-sse/services/accountFallback.ts`                                      | Account cooldowns, fallback and model lockouts; preserve scope and retry budget                                                 |
| `src/app/api/v1/models/catalog*.ts`, `src/lib/db/models/*`, `src/lib/providerModels/*`                  | Synced catalogs and caching; generic static-row merge needs explicit authoritative FreeBuff semantics                           |
| `open-sse/services/sessionPool/{types,sessionPool}.ts`                                                  | Anonymous browser-session pool, NOT a matching FreeBuff account-session abstraction                                             |

Some paths above were inspected by surrounding architecture/tree rather than a complete line-by-line
review; the executor, session admission, catalog merge and request-target paths received deeper
inspection. Shared protocol correctness is a test target, not certified by this audit.

## Reference implementation comparison

### trefeon/freebucks-proxy

Inspected `backend/internal/{session/session_manager.go,upstream/session.go,upstream/chat.go,
upstream/client_chat.go,registry/registry_refresh.go,registry/registry.go,pool/bridge.go,
server/responses.go,server/responses_stream.go,server/anthropic_stream.go,
convert/convert_request.go,convert/toolmap_request.go}` and `.goreleaser.yml`.

Useful: dedicated admission/reuse paths; read-only probe; single-flight refresh with shared
failure result; active-run guard around session replacement; detailed quota/session state;
bridge token ownership; atomic catalog refresh; actual Responses conversion and stream handling;
Linux/ARM64 release target. Tree inspection shows substantial conformance, lifecycle, health,
quota and metrics testing infrastructure; those tests were not executed here.

Cautions: breadth makes it much larger than a focused provider. Tool-name remapping explicitly
aims to neutralize foreign-client detection and is excluded. Session grace/admission behavior
must be checked against current official source. Its dual-auth comment references a different
official location/revision; the currently inspected SDK agent-run code uses Bearer auth, so do
not cargo-cult extra headers from a proxy comment. It is the best inspected engineering reference,
not a blanket endorsement or a live-tested deployment recommendation.

### lza6/Freebuff-2API

Rust/Axum routes implement Chat Completions and Anthropic; no `/v1/responses` route found in the
inspected API router. `pool.rs` implements account health/score and circuit-breaker state;
`semaphore.rs` uses owned permits with timed acquisition; `retry.rs` provides classified bounded
backoff. SSE has dedicated OpenAI and Anthropic modules. Useful concepts: RAII-style lease
release and explicit backpressure, not a reason to introduce Rust into this fork.

`session.rs` caches active instances but its active fast path does not compare the requested
model; mutex release before create also deserves concurrency review. Unknown status strings
map to None, risking loss of denial semantics. `upstream.rs` still POSTs legacy `/session`,
sends a Desktop multi-session header, and its heartbeat method ignores HTTP status. The session
module explicitly incorporates ad-renewal behavior, which is excluded. Health/quota interfaces
exist in its codebase, but actual balance correctness and Linux ARM64 operation were not tested.

### chenjh16/freebuff2api

Useful: explicit browser/device login with persisted pending transaction; strict START response
validation; bounded session recreation; one shared refresh promise; queued state and cooldown;
model parser resolves imported identifiers rather than only literals; unit fixtures and an
agentic CLI test harness. Runs are cached by token+agent and finished on rotation/shutdown.

Limitations: source is Aug 8; session creation still uses the legacy path and treats 404 as
disabled. Catalog fallback is dated and refresh fetches moving source files. Raw token fragments
are used as labels; do not adopt that logging. The handler injects an official system marker to
pass a client gate, and passthrough HTTP success is not stream-completion evidence. Public-upstream
fallback must not be mistaken for FreeBuff inference success. Its published test records were
not independently rerun and do not prove current protocol compatibility.

### Quorinex/Freebuff2API

Small Go architecture is easy to follow: shared session refresh, run manager and periodic model
refresh. `models.go` uses the older CodebuffAI/codebuff URL, parses only quoted literals inside
agent sets, then chooses an agent at random when several match. Current official constants and
root maps make that strategy unreliable; the fallback catalog is old. Good simplicity reference,
not the selected protocol source. Current token reauthentication, Responses, multimodal and live
stream correctness remain unverified rather than assumed absent.

### fatmuh/freebuff-proxy

`model-pool-manager.ts` groups accounts by model, prefers active pools, records in-flight counts,
and bounds per-account acquisition retries. `run-manager.ts` has session queues, idle maintenance,
successful/failed run finalization and quota pause state. Actual chat and Responses routes and
conversion modules exist. Authentication/reauthentication code is separate from pool management.

Do not copy: no LICENSE was found; tree includes synthetic-fingerprint, fake-conversations and
ads-spoof modules. Source also retries model locks by ending sessions and mentions changing IP
after a cap; these conflict with the selected ownership/access rules. The Aug 13 head's tool-gate
workaround does not establish current official compatibility. No credentials/captured auth file
from this repository were opened or imported.

## Official contract findings

Authoritative inspected sources at the official revision above:

- `cli/src/utils/freebuff-session-api.ts`: dedicated admission, typed denial/queue/spend states,
  20-second request timeout, Retry-After parsing, and explicit unknown outcome for lost POST replies.
- `common/src/constants/freebuff-models.ts`: exact-instance reuse, wallet cap, compact polling,
  heartbeat interval, Desktop-only multi-session flag, expiry/grace and model lifecycle metadata.
- `common/src/constants/free-agents.ts`: surface-specific base2/base3 root maps; not all allowed
  agent/model pairs are valid user-facing model offerings; canonical system-prompt policy.
- `common/src/constants/foreign-client-signals.ts`: genuine schema checks and enforced downgrade
  for foreign toolsets/names/system prompts. This makes restriction evasion a real design concern.
- `sdk/src/impl/database.ts`: START with agentId/ancestorRunIds, FINISH with truthful status and
  accumulated steps; `/me` read path. Do not invent a `/steps` endpoint.
- `cli/src/login/login-flow.ts`: browser-assisted login/polling. No reusable refresh-token grant
  was established in the inspected flow.

A public repository snapshot is not a versioned supported third-party API guarantee. P0 must
confirm supported access and verify production wire behavior using a legitimate test account.

## Complete FreeBuff reference inventory

Case-insensitive content search of the pinned baseline found **147 files**: 17 non-localized
paths below plus **130 localized mirrors** (65 locales × CHANGELOG and PROVIDER_REFERENCE).
The mirror paths are `docs/i18n/<locale>/CHANGELOG.md` and
`docs/i18n/<locale>/docs/reference/PROVIDER_REFERENCE.md` for every locale listed below.

Non-localized paths:

```text
CHANGELOG.md
config/quality/file-size-baseline.json
docs/reference/PROVIDER_REFERENCE.md
open-sse/config/providers/index.ts
open-sse/config/providers/registry/freebuff/index.ts
open-sse/executors/freebuff.ts
open-sse/executors/index.ts
src/app/(dashboard)/dashboard/providers/[id]/components/modals/AddApiKeyModal.tsx
src/lib/providers/validation.ts
src/shared/components/ProviderIcon.tsx
src/shared/constants/providers/apikey/gateways.ts
tests/snapshots/executors/executor-map.json
tests/snapshots/provider/translate-path.json
tests/unit/freebuff-provider.test.ts
tests/unit/provider-assets-generic-fallback.test.mjs
tests/unit/providers-constants-split.test.ts
tests/unit/ui/ProviderIcon-icon-url.test.tsx
```

Locales: am, ar, az, bg, bn, cs, da, de, el, es, et, fa, fi, fr, ga, gu, ha, he, hi,
hr, hu, hy, id, ig, it, ja, ka, km, kn, ko, lt, lv, ml, mr, ms, mt, my, ne, nl, no,
or, pa, phi, pl, pt, pt-BR, ro, ru, si, sk, sl, sr, sv, sw, ta, te, th, tr, uk-UA,
ur, uz, vi, yo, zh-CN, zh-TW.

Do not edit translated documentation, generated snapshots, icon fixtures or unrelated registry
tests unless a scoped behavior change requires it. The runtime core is far smaller than the
reference count suggests.
