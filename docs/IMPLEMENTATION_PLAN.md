---
title: "LLM-Router: FreeBuff Implementation Packets"
lastUpdated: 2026-09-22
---

# Implementation packets — Luna Max handoff

**READY FOR LUNA MAX for P0 and offline foundation work.** Live FreeBuff coding-client support
is gated by permitted upstream access, not just engineering completion. Read
[architecture](ARCHITECTURE.md), [decisions](DECISIONS.md), [audit](FREEBUFF_AUDIT.md) and
[status](STATUS.md) first. Do not redesign the fork or silently remove the feasibility gate.

## Execution rules

Use `dev` as integration base. Create isolated feature worktrees in the AGENTS.md-prescribed
location; keep `release/v3.8.51` at the recorded baseline. Check the current remote tip before
starting and publishing. Never stash, force-push, or touch another session's worktree. Use GitHub
MCP for repository operations and publish focused stable milestones. No third-party writes.

All production changes need meaningful failing-then-passing regression tests under `tests/`.
Tests must use fake credentials, isolated DATA_DIR, deterministic clocks/randomness, injected
fetch or a local mock upstream, and must close databases/timers/servers. No real network in CI.
All new file paths below are **proposed**, not already available. Inspect the actual current
interfaces before implementing; if a concrete blocker changes the architecture, document it.

Update STATUS after each packet with commit, exact commands/results, remaining failures and next
packet. Preserve notices for any adapted licensed code; use independent implementation by default.
No fabricated official-client identity, tool camouflage, ad simulation, quota resets or IP/account
cycling to evade limits. No secrets in fixtures, debug output, commits or health responses.

Recommended order: **P0 → P1 → P2 → P3 → P4 → P5 → P6**. P4 catalog work can be developed after
P1, but integrate sequentially to avoid competing changes to the executor. Return for architectural
review after P2 and again after P5; do not spend review time on broad cosmetic changes.

## P0 — Establish the supported contract and regression harness

**Objective:** separate feasible, authorized integration from gateway correctness; pin reproducible
fixtures before implementing a provider against stale proxy assumptions.

**Files:** current `open-sse/executors/freebuff.ts`, registry `freebuff/index.ts`,
`src/lib/providers/validation.ts`, `tests/unit/freebuff-provider.test.ts`; new
proposed fixture directory `tests/fixtures/freebuff/`; proposed `freebuff-executor-lifecycle.test.ts`
under `tests/unit/`, and optional `freebuff-live-smoke.mjs` under `scripts/test/`
(gated, no default live execution).

**Required work:**

1. Review pinned official session/login/run/model and foreign-client-policy evidence. Identify
   permitted endpoint/credential scope; document vendor confirmation or contract if available.
   Do not make live calls against a prohibited client surface merely because a token exists.
2. Record exact request/response schemas for admission, read-only validation, active/queued/denied
   states, run START/FINISH, model identity, tool calls, reasoning and supported image content.
   Include source revision and provenance; synthetic fixtures are explicitly labeled synthetic.
3. Reproduce current weaknesses with mocked fetch: FINISH-before-body, ignored START failure,
   metadata override, queued-as-active, aborted acquisition, unsafe raw error and missing instance.
4. Add a harness that can hold the upstream response body open and observe call order, pending
   leases, dispatch count, abort propagation and sanitized errors. Avoid implementation-mirroring
   assertions about private variable names.

**Acceptance:** no live access claim without permitted contract evidence; no real secrets or
captured third-party auth; baseline defects have deterministic failing regressions. The live
report distinguishes requested model, returned model, server-reported downgrade and unknown model
identity. HTTP 200 alone never passes model-fidelity acceptance. If blocked, record the exact
blocked capabilities and continue only safe offline packets.

**Do not change:** generic translators, account routing, upstream branches, ports or deployment.

## P1 — Typed client, errors, credential validation and metadata boundary

**Objective:** introduce a small injectable transport boundary and fix prerequisite validation.

**Files:** new `open-sse/executors/freebuff/{types,schemas,client,errors,request}.ts`;
existing executor; `src/lib/providers/validation.ts`; FreeBuff hints only in
`src/shared/constants/providers/apikey/gateways.ts` and the existing AddApiKeyModal when needed;
new tests under `tests/unit/`: `freebuff-client.test.ts`, `freebuff-request.test.ts`,
`freebuff-validation.test.ts`.

**Required behavior:** Zod validates upstream discriminated states and mandatory IDs. Keep approved
base URLs and payload bounds explicit. Inject fetch/clock; combine caller cancellation with
operation timeouts. Honor the existing configured egress/proxy boundaries; do not silently send
traffic outside a connection-specific proxy. Session admission uses the verified dedicated path, zero spend default and
no unsafe legacy fallback. No automatic transport retries for unknown-outcome mutation. Normalize
errors through existing `buildErrorBody`/sanitization helpers; preserve Retry-After and error scope.
Read-only auth validation must distinguish 401, forbidden access, no session, quota and outage.
Return diagnostic state without admission side effects. Protect all internal metadata and trusted
headers from downstream override. Preserve client messages/tools exactly except justified,
documented protocol translation; no spoof identity workaround. Fail START before chat if invalid.

**Acceptance/tests:** table-driven malformed/non-JSON/oversized response tests; 401/403/404/405/409/
429/5xx and date/seconds retry hints; aborted requests; secrets embedded in upstream error text;
reserved-metadata attacks; no credential cross-contamination; validation sends zero admission calls.
Original empty-token tests continue to pass. Avoid adding an OAuth refresh flow without evidence.

**Do not change:** storage schema, generic provider behavior, global auth or fingerprint settings.

## P2 — Session leases, bounded admission and truthful run lifecycle

**Objective:** reuse owned sessions safely and make resource accounting race-resistant.

**Files:** new `freebuff/{sessionManager,runManager,runtime}.ts`; executor; existing
`open-sse/services/accountFallback.ts` and `src/sse/services/auth.ts` only for a proven narrow
integration requirement; new tests under `tests/unit/`: `freebuff-session-manager.test.ts`,
`freebuff-run-manager.test.ts`, `freebuff-concurrency.test.ts`.

**Required behavior:** one account-session owner per credential generation, including duplicate
configured tokens; one active completion per credential, two global, eight queued, bounded wait.
Queue fairness is FIFO within a credential; no permit held indefinitely while waiting for another.
Single-flight admission shares the same outcome with followers, with caller-independent cancellation.
State transitions cover queued, active, expired/draining, superseded, model-locked, unavailable,
banned, country-blocked, spend-limited, IP-capped and unknown states. Unknown is an error, not idle.
Poll without POST storms. Refuse unowned-session takeover and model switch while leased. On restart,
reconcile; do not blindly create a competing instance. Use idle release and bounded shutdown.

Runs are per request; START failure releases local resources. Expose a finalize-once handle for P3.
Delay FINISH to response consumption. Only owned sessions may be deleted; targeted cleanup uses an
independent short timeout. No fake steps/usage or success on cancellation. Do not add a second
credential rotator/circuit breaker; coordinate normalized failures with existing scopes.

**Acceptance/tests:** 20 concurrent synthetic requests cannot create 20 sessions; limits remain
bounded; leader abort leaves followers well-defined; stale refresh cannot replace new credential
state; failed shared admission does not trigger one POST per waiter; model switch/expiry while
streaming cannot replace live instance; shutdown resolves/rejects all waiters and returns counters
to zero; 429 Retry-After and terminal bans never trigger cap-evasion loops. Test ambiguous POST
outcome reconciliation without duplicate admission. Test cleanup failures without leaked permits.

**Review gate:** review lease ownership, lock order, cancellation and retry multiplication before P3.
Do not persist tokens/sessions in a new unencrypted store or enable multiple workers.

## P3 — Streaming lifetime, cancellation, error integrity and tools

**Objective:** a completion's actual body lifetime controls the session/run lease.

**Files:** new `freebuff/responseStream.ts`; executor/run manager; inspect existing
`open-sse/handlers/chatCore/streamingPipeline.ts` and `open-sse/utils/` SSE helpers for reuse;
new `freebuff-stream.test.ts` under `tests/unit/` and `freebuff-chat.test.ts` under
`tests/integration/`.

**Required behavior:** pull-based bounded observation of upstream SSE; decoder survives arbitrary
UTF-8 splits and CRLF; multiline data and comments handled correctly. Detect terminal completion,
error frames, missing terminator and malformed oversized events. Finalize only after completion or
failure/cancel, never after headers. Client cancel cancels the upstream reader and transport;
cancelled cleanup still has its own finite budget. No replay after emitted content/tool deltas.
Non-streaming JSON gets the same lifetime and error semantics. Preserve tool names, IDs, indices,
arguments and results. Never inject signature tools or rename tools to circumvent upstream checks.

**Acceptance/tests:** split every byte boundary of text and tool fixtures; interleaved parallel tools;
arguments containing braces/escaped quotes; usage-only final chunk; [DONE] split across reads;
truncated EOF; stream-level error after partial text; cancel before headers, mid-body and after
terminal; slow reader proves bounded buffering. Exactly one local finalizer call per run in every
path. Inspect the public Chat endpoint, including a tool call → result → final reply cycle.

**Do not change:** shared SSE semantics unless a failing shared-path test proves the need. Add a
non-FreeBuff regression fixture whenever a shared helper must change.

## P4 — Official catalog snapshot and authoritative model integration

**Objective:** replace stale discovery without confusing membership, permission and capability.

**Files:** new `freebuff/{catalog,catalogParser}.ts`, generated fallback fixture with provenance;
existing registry; inspect `src/lib/providerModels/{modelDiscovery,reactiveModelSync}.ts`,
`src/lib/services/modelSync.ts`, `src/lib/db/models/{synced,activeSyncedCatalog}.ts`,
`src/app/api/v1/models/{catalog,catalogSyncedCoverage,catalogCache}.ts`,
`src/sse/services/model.ts`; new `freebuff-catalog.test.ts` under `tests/unit/` and
`freebuff-models.test.ts` under `tests/integration/`.

**Required behavior:** fetch official files at a single resolved commit; bounded timeout/size,
conditional refresh where available; no eval/import execution of fetched TypeScript. Parse only
supported data constructs, reject partial/conflicting snapshots. Source-specific root maps, retired
rows and surface eligibility are explicit. Unknown capabilities remain unsupported/unknown.
Keep last-known-good on fetch/parse failure; mark staleness. Refresh failure is distinct from a
valid empty eligible set. Remove stale rows from listing AND routing, including custom/alias
resolution interactions, without resurrecting static rows. Reuse domain persistence and cache
invalidation APIs; no raw SQL in routes. No remote scrape per inference request.

**Acceptance/tests:** new/removed/renamed model; imported constant; base2/base3 root distinction;
helper-agent exclusion; surface-only model; duplicate/conflict; malicious source expression;
oversized source; mixed-revision prevention; empty inventory; startup offline; failed refresh
retains last-good; stale ceiling; canonical/alias consistency; two connections with different
availability; `/v1/models` agrees with executor acceptance. Existing other-provider model tests pass.

**Do not change:** all providers' catalog merge policy, global aliases or global capability defaults.

## P5 — Gateway protocol conformance, capability limits and health

**Objective:** verify all public protocol paths through OmniRoute and expose honest health.

**Files:** new tests under `tests/integration/`: `freebuff-responses.test.ts`,
`freebuff-anthropic.test.ts`, `freebuff-capabilities.test.ts`; `freebuff/health.ts`; inspect existing monitoring route and usage
hooks. Existing Responses/Anthropic request/response translators and targetFormat resolver are
test targets, not permission for wholesale rewrites.

**Required behavior/tests:**

- Responses instructions + input, function declarations, named tool_choice, multiple function
  calls/results, custom tool behavior, output-item IDs and ordered deltas/done/completed or failed
  events; actual upstream payload must be Chat-shaped with correct model and no lost instructions.
- Anthropic system/content, text/tool_use/tool_result, stable content-block indices, stop reasons,
  usage and error events. Tool output feeds the next request without fabrication or dropped IDs.
- Reasoning effort accepted values are model-specific; unknown/unsupported values fail explicitly.
  Only genuine returned reasoning is exposed. Do not fabricate encrypted reasoning or signatures.
- Image tests preserve supported text/image arrays through each protocol; unsupported models return
  a clear error and are not marked vision-capable. Do not silently convert tool-output images to
  lost content while claiming full multimodal support.
- Explicitly reject or truthfully document unsupported background, hosted tools, stateful IDs and
  WebSocket features. Test `previous_response_id` instead of assuming its semantics from route existence.
- Health counters observe session reuse, leases, queue, catalog age, errors, cleanup and latency;
  no token/session/run identifiers, raw errors or user content. Polling health creates no session.

**Acceptance:** mock end-to-end paths pass for Chat, Responses and Messages, including errors and
cancellation. A representative non-FreeBuff provider remains green on the same paths. Optional
live tests run only after P0, never in ordinary CI; record exact returned model and any downgrade.
Codex CLI, Pi/OpenCode and Claude-compatible client smoke results are individually labeled tested,
blocked or not run. No blanket compatibility badge from unit tests.

**Review gate:** architecture/protocol review before deployment.

## P6 — ARM64 build, live acceptance and deployment readiness

**Objective:** a reproducible, reversible deployment of a tested commit, only after live gates pass.

**Files:** `docs/STATUS.md`, configuration examples, an optional fork-specific deployment document
under `docs/ops/`, and proposed `freebuff-live-smoke.mjs` under `scripts/test/`.
No secrets in example configuration.

Run focused tests first; use repository-supported Node and lockfile. Run applicable lint/typechecks,
both main test runners, provider consistency and build gates required by AGENTS/CI. On the two-core
VPS, run suites sequentially with conservative concurrency and isolated data. Do not fix unrelated
base-red failures inside this packet. Verify ARM64 SQLite/runtime artifacts, memory use under two
concurrent slow streams, shutdown/rollback and non-FreeBuff requests.

Proposed live suite: one text completion, one stream, a two-turn tool cycle, Responses equivalents,
Anthropic equivalent where permitted, a harmless capability test and client cancellation. Set a
hard request/time/spend budget; do not deliberately exhaust quota or trigger account restrictions.
Missing credentials or permitted access is **blocked**, not passed. Preserve sanitized evidence
with date, commit, client/version, requested/returned model, mode and result.

Deployment uses a new service directory and operator-approved free port; no restart or alteration
of MCP/connectivity services. Back up existing router data before migrations if a deployment is
later present. Pin commit and artifacts; rehearse rollback. Record deployment state and push all
stable work before handoff. No production/default branch merge just because the build succeeds.

## Standard focused commands

After dependencies are installed in an isolated worktree, run the specific new test files with:

```bash
node --import tsx/esm --test tests/unit/freebuff-provider.test.ts
node --import tsx/esm --test tests/unit/freebuff-client.test.ts
npm run typecheck:core
npm run lint
npm run check:docs-all
```

Paths for new tests become runnable only after their packet creates them. Use existing setup/
isolation imports from package.json for integration tests. Before integration merge, run both
`npm run test:unit` and `npm run test:vitest`, plus the required changed-surface gates. Before
deployment run `npm run build` and the bounded live suite. Record failures faithfully; no hook or
gate bypass, secret-containing transcript, or untested completion claim.
