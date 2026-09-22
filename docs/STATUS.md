---
title: "LLM-Router: Project Status"
lastUpdated: 2026-09-22
---

# Status — lifecycle, streaming, model discovery, protocol conformance, and P6 gate

Phase 1, P2 lifecycle, P3 streaming, and P4 model discovery are integrated into `dev`.
P4 was integrated by a dependency-preserving fast-forward to
`a6cdd8c9267888fdbe339f52aca7708b90eba935`, followed by the `dev` documentation checkpoint
`ea2158b023f4227efd7ce70a11f9a0ba0cb5238b`. P5 was independently reviewed and then
fast-forwarded into `dev` through `5fb1843799e409144c7c01627d485d31e2ef5865`. The validated
P2/P3/P4 history is preserved; no merge commit or force-push was used. The P5 review found and
fixed one important lifecycle-health accounting defect before integration.

This checkpoint does not certify permitted live FreeBuff model access or production deployment.

## Integrated work

### P2 lifecycle

- Credential-fingerprint session ownership with single-flight admission and read-only reconciliation.
- Bounded scheduling: one active completion per credential, two globally and eight queued.
- Caller-independent shared-admission cancellation, FIFO fairness per credential and bounded waits.
- Refusal of unowned-session takeover and model switching while leased.
- Owned-instance-only idle cleanup, cleanup/reacquire serialization, ambiguous-cleanup reconciliation,
  expiry-while-leased refusal and bounded shutdown.
- Finalize-once request runs with FINISH only after the response body reaches a terminal state.

### P3 streaming

- Pull-based response wrapping for SSE and non-streaming JSON that preserves downstream bytes.
- Bounded UTF-8/SSE observation with CRLF/CR/LF, comments, multiline data, terminal `[DONE]`,
  malformed/oversized/truncated streams and upstream error-frame detection.
- Caller abort and downstream cancellation propagate to the upstream reader and finalize the run.
- Tool-call fragments and names remain untouched; no signature-tool injection or tool renaming.
- Validation failures cancel the upstream reader before local cleanup completes.

## P4 model discovery

`freebuff-p4-model-discovery` is now integrated into `dev`; its final branch head was `a6cdd8c9267888fdbe339f52aca7708b90eba935`. The approved authoritative-source design is:

- Fetches the official `CodebuffAI/freebuff` source files at one pinned revision,
  `a37beff7a5db909eb6db54654431bb521af7da1a`.
- Parses only constrained constants, model records, the base2 root-agent map, the offered
  `FREEBUFF_MODELS` surface and `FREEBUFF_PAUSED_FREE_MODEL_IDS`; fetched TypeScript is never
  evaluated or imported.
- Rejects mixed revisions, unsupported expressions, duplicate/conflicting mappings, missing
  display names and incomplete offered-to-agent mappings atomically.
- Uses a six-hour refresh interval, a 10-second per-file timeout, a bounded source size, single-flight
  refreshes and abort propagation.
- Retains last-known-good data for up to seven days, distinguishes valid empty inventories from
  failures, and otherwise uses a provenance-bearing emergency fallback generated from the same
  official revision.
- Keeps executor model-to-agent resolution on the validated in-memory snapshot, with no remote
  discovery request per inference. The provider registry and `/v1/models` use the same normalized
  catalog; the explicit provider sync route can persist official/empty/last-known-good rows through
  OmniRoute's existing synced-model API without persisting an emergency fallback as fresh.
- Capability flags are evidence-based: reasoning is present only when the source declares a reasoning
  field; vision follows the source's explicit `multimodal` value; tools, video, context size and
  Responses support remain unknown rather than assumed.

### P4 validation

Validated in the ARM64 VPS worktree using the existing `v24.13.0-linux-arm64` runtime:

- Discovery/parser/cache tests: **13 passed, 0 failed**.
- Combined FreeBuff provider, lifecycle, concurrency, run, session, streaming and discovery tests:
  **68 passed, 0 failed**.
- Official pinned-source smoke parse: **8 active base2 models**, with paused rows excluded.
- `npm run check:open-sse-typecheck`: **0 errors; pass**.
- `npm run typecheck:core`: **pass**.
- Targeted ESLint for changed P4 files: **pass**.
- Prettier check: **pass**.
- `git diff --check`: **pass**.

The full route lint still reports unrelated pre-existing warnings in the large catalog module when that
whole file is linted; the changed P4 service/import boundary itself is clean.

## P5 protocol conformance

`freebuff-p5-protocol-conformance` is based on `dev` at
`ea2158b023f4227efd7ce70a11f9a0ba0cb5238b`. The packet keeps the existing shared
translator and executor stack and adds no second protocol implementation.

Published P5 commit checkpoints:

- Implementation: `0b2901ef54819994cfcd517995c7dd06ca463874`.
- Documentation checkpoint: `1a0db5eda721d3a3248063bdf119c93b9e3b1a1b`.
- Formatting checkpoint: `55b052d40013ee28adbf754faea6fec10571a049`.
- Independent-review fix: `5fb1843799e409144c7c01627d485d31e2ef5865`.

- Offline route fixtures exercise OpenAI Chat Completions JSON and SSE, OpenAI Responses
  instructions/input conversion plus named/multiple tool-call continuity, and Anthropic Messages
  content blocks.
- Tool continuity is checked through the gateway: Chat tool-call IDs/names/results and Anthropic
  `tool_use`/`tool_result` IDs survive the second turn without renaming.
- The capability projection remains evidence-only: FreeBuff rows advertise `chat` only; reasoning
  and vision are emitted only when the official catalog source declares them. Tool, Responses,
  video, audio, and context capabilities are not fabricated.
- `open-sse/services/freebuffHealth.ts` exposes a passive monitoring boundary. The snapshot reports
  catalog provenance/age/staleness, scheduler depth, credential-scoped session counts, bounded
  latency/error counters, and no credentials, run IDs, instance IDs, messages, or upstream bodies.
  Health reads never acquire a session or perform network discovery.
- Existing P2/P3 lifecycle and streaming finalization remain the ownership boundary. The review
  moved request outcome/latency recording onto that exactly-once terminal settlement, so truncated
  streams and cancellations are failures rather than premature successes; auth, rate-limit,
  forbidden, upstream, abort, and malformed classes remain bounded and sanitized.

### P5 validation

Independently validated in a clean ARM64 VPS worktree with the existing
`v24.13.0-linux-arm64` runtime:

- Complete FreeBuff unit set: **72 passed, 0 failed**, including lifecycle, concurrency, transport,
  discovery, streaming, capability, terminal health, malformed-stream, and cancellation cases.
- P5 public Chat/Responses/Anthropic route integration: **8 passed, 0 failed**.
- Representative shared/non-FreeBuff Chat pipeline: **29 passed, 0 failed**.
- `npm run check:open-sse-typecheck`: **0 errors; pass**.
- `npm run typecheck:core`: **pass**.
- Targeted ESLint across the complete P5 diff: **pass**.
- Prettier check across the complete P5 diff: **pass**.
- `git diff --check`: **pass**.
- Repository secret check: **gracefully skipped because `gitleaks` is not installed**; independent
  changed-diff review found no credentials or secret material.

Review classification: **0 blockers, 1 important finding fixed, 0 unresolved important findings**.
The remaining limitations below are documented and unadvertised rather than silently certified.
P5 is integrated into `dev`; the feature branch preserves its dependency history.


## P6 deployment-readiness gate

P6 is isolated on `freebuff-p6-deployment-readiness`, based on integrated `dev` at
`cd6c254bbab77e723830a3758d1ad188d3662e6e`. The initial implementation/documentation checkpoint is `55e345d6bd09cee15c065096595bc03ef20c7ac9`; the bounded-harness cleanup follow-up is
`a76814f7aa5511bcd84dfcefa62ee9fc5114b134`; the verified-runtime path correction is
`fa5a8d7218a1db2a2e63f65679edd5ece9da5338`. Only the bounded live harness,
deployment/rollback operations document, deployment decision, and this gate
record were added; P2–P5 code and `dev` were not modified.

### ARM64/offline evidence

- The approved VPS runtime was explicit Node.js `v24.13.0-linux-arm64`
  (`aarch64`, 2 cores, about 11 GiB RAM); npm was 11.6.2.
- `npm ci --include=optional --no-audit --no-fund --ignore-scripts` passed
  (2,537 packages added). npm emitted only the existing jsdom preferred-engine
  warning for Node 24.13.0.
- `npm run check:node-runtime` passed.
- `npm run check:native-deps` passed: all 33 externalized packages resolved,
  including 8 optional dependencies. The ARM64 load matrix passed for
  better-sqlite3, sharp, @swc/core, esbuild, onnxruntime-node, and wreq-js.
  `node-pty` is not a current dependency or source reference and was not
  added.
- `npm run check:build-scope` passed (9,355 source files, below the 12,000
  guard).

### Build and remaining offline gates

- A build forced to a 4 GiB heap failed with a Next webpack-worker JavaScript
  heap OOM. This was an invalid low-memory override, not evidence of a source
  regression, but it is not a passing build.
- A second build was started with the documented 8 GiB budget, durable logging,
  and the approved ARM64 runtime. The VPS tunnel-client stopped responding while
  it was running; the final log, exit status, standalone artifact, and host
  state are therefore unverified.
- Because the VPS connector is unavailable, P6 has not claimed isolated
  startup, readiness/liveness/database health, TERM shutdown, restart,
  rollback rehearsal, resource/concurrency smoke, non-FreeBuff regression, or
  the remaining full P6 validation suites. The published harness passes local
  `node --check` and its disabled-path smoke; its ARM64/VPS recheck remains
  blocked, and no result is inferred from the lost session.
- The connector error was reported once and retries stopped. No deployment,
  service activation, public routing change, data migration, or MCP change was
  performed.

### Live and security status

- Approved-environment credential-name checks found no authorized FreeBuff or
  gateway credentials; values were never inspected. No live FreeBuff inference,
  third-party client smoke, or credential validation was performed.
- `LIVE FREEBUFF VALIDATION BLOCKED: AUTHORIZED ACCESS REQUIRED`
- No secrets were committed. A lightweight pattern scan of the four changed
  remote files found no credential patterns; the repository gitleaks scan remains
  pending because the VPS connector failed before it could be rerun. The changed
  diff contains only placeholders and sanitized harness output fields.

### P6 classification

**P6 BLOCKED — OFFLINE GATE INCOMPLETE (VPS CONNECTOR UNAVAILABLE).**

This is not one of the successful end-state classifications: `OFFLINE
DEPLOYMENT READY` requires a passing build and isolated runtime/rollback
checks. No live-failure classification is applicable because no authorized
live request was made. Restore the VPS connector and finish the offline gate
before any merge or deployment decision.

## Live behavior and limitations

- Live FreeBuff inference: **not performed**.
- `LIVE FREEBUFF VALIDATION BLOCKED: AUTHORIZED ACCESS REQUIRED`
- Live credential validation: **not performed**.
- The official GitHub source was fetched read-only at the pinned public commit; no restricted endpoint,
  credential, inference, deployment, firewall, DNS, proxy or service change was performed.
- Requested-model fidelity and third-party coding-client compatibility: **not verified**.
- No token, cookie, session secret, auth file or personal identifier was committed.
- The official foreign-client restriction remains a real feasibility boundary; no spoofing, tool
  renaming, engagement simulation, quota/account/IP evasion or other bypass was added.

## Next packet

Restore the VPS connector, inspect the durable 8 GiB build log and host state,
then complete the isolated startup/health/shutdown/restart, rollback,
resource/concurrency, non-FreeBuff, secret-scan, and relevant regression gates.
Only after the offline gate is clean should authorized live validation be
considered. Do not merge P6 into `dev` while the gate is incomplete.

## Deployment state

**Not deployed and not deployment-ready.** `dev` remains
`cd6c254bbab77e723830a3758d1ad188d3662e6e`; the P6 branch is intentionally
isolated. The existing MCP service, public routing, data directories, and
system services were not changed.
