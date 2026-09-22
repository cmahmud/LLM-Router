---
title: "LLM-Router: Project Status"
lastUpdated: 2026-09-22
---

# Status — lifecycle, streaming, P4 integrated; P5 protocol conformance complete on isolated branch

Phase 1, P2 lifecycle, P3 streaming, and P4 model discovery are integrated into `dev`.
P4 was integrated by a dependency-preserving fast-forward to
`a6cdd8c9267888fdbe339f52aca7708b90eba935`, followed by the `dev` documentation checkpoint
`ea2158b023f4227efd7ce70a11f9a0ba0cb5238b`. The validated lifecycle/streaming history is
preserved; no merge commit or force-push was used. The P4 review found no unresolved material
defect. P5 is implemented only on the isolated `freebuff-p5-protocol-conformance` branch based
on that exact `dev` head; `dev` remains unchanged by P5.

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

- Offline route fixtures exercise OpenAI Chat Completions JSON and SSE, OpenAI Responses
  instructions/input conversion, and Anthropic Messages content blocks.
- Tool continuity is checked through the gateway: Chat tool-call IDs/names/results and Anthropic
  `tool_use`/`tool_result` IDs survive the second turn without renaming.
- The capability projection remains evidence-only: FreeBuff rows advertise `chat` only; reasoning
  and vision are emitted only when the official catalog source declares them. Tool, Responses,
  video, audio, and context capabilities are not fabricated.
- `open-sse/services/freebuffHealth.ts` exposes a passive monitoring boundary. The snapshot reports
  catalog provenance/age/staleness, scheduler depth, credential-scoped session counts, bounded
  latency/error counters, and no credentials, run IDs, instance IDs, messages, or upstream bodies.
  Health reads never acquire a session or perform network discovery.
- Existing P2/P3 lifecycle and streaming finalization remain the ownership boundary; P5 only adds
  instrumentation around those paths.

### P5 validation

Validated in the ARM64 VPS worktree with the existing `v24.13.0-linux-arm64` runtime:

- P5 route/capability/health focus: **21 passed, 0 failed** (7 route/health integration,
  1 capability projection, and the existing 13 discovery/parser/cache cases).
- Combined pre-existing FreeBuff lifecycle/transport suite: **68 passed, 0 failed**.
- `npm run check:open-sse-typecheck`: **0 errors; pass**.
- `npm run typecheck:core`: **pass**.
- Targeted ESLint: **pass**.
- Prettier check: **pass**.
- `git diff --check`: **pass**.

P5 branch implementation and documentation commit SHAs are recorded in the final handoff; the
current branch remains isolated from `dev`.

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

`P6 — authorized live contract validation and deployment gate`: only with explicit authorized
FreeBuff access, rerun the bounded live session/admission/Chat/Responses/Anthropic/stream
validation and review deployment readiness. No live inference, credential validation, or deployment
is claimed by P5. If authorization is not available, the next work should be architectural review
of the offline packet rather than an access workaround.

## Deployment state

**Not deployed and not production-ready for live FreeBuff.** The primary VPS checkout at
`/home/ubuntu/projects/llm-router-dev` remains clean on `dev` at
`ea2158b023f4227efd7ce70a11f9a0ba0cb5238b`. P4 validation ran in
`/home/ubuntu/projects/llm-router-p4-model-discovery`; P5 validation ran in
`/home/ubuntu/projects/llm-router-p5-protocol-conformance`; GitHub remains the durable source of truth.
