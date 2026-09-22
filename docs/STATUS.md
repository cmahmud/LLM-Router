---
title: "LLM-Router: Project Status"
lastUpdated: 2026-09-22
---

# Status — lifecycle, streaming, and P4 integrated; P5 isolated

Phase 1, P2 lifecycle, P3 streaming, and P4 model discovery are integrated into `dev`.
P4 was integrated by a dependency-preserving fast-forward to
`a6cdd8c9267888fdbe339f52aca7708b90eba935`, preserving the validated lifecycle/streaming
history. PR #1 remains draft/open/unmerged and is historical; no merge commit or force-push was
used. The P4 review found no unresolved material defect.

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

## Live behavior and limitations

- Live FreeBuff inference: **not performed**.
- Live credential validation: **not performed**.
- The official GitHub source was fetched read-only at the pinned public commit; no restricted endpoint,
  credential, inference, deployment, firewall, DNS, proxy or service change was performed.
- Requested-model fidelity and third-party coding-client compatibility: **not verified**.
- No token, cookie, session secret, auth file or personal identifier was committed.
- The official foreign-client restriction remains a real feasibility boundary; no spoofing, tool
  renaming, engagement simulation, quota/account/IP evasion or other bypass was added.

## Next packet

Create the isolated branch `freebuff-p5-protocol-conformance` from the current `dev` head. The packet
covers offline gateway protocol conformance, tool continuity, capability limits, and sanitized
FreeBuff health. Live validation remains blocked unless authorized access already exists.

## Deployment state

**Not deployed and not production-ready for live FreeBuff.** The primary VPS checkout at
`/home/ubuntu/projects/llm-router-dev` remains clean on `dev` at
`b216f43172682fab44528382e3e022977bb9a449`. P4 validation ran in
`/home/ubuntu/projects/llm-router-p4-model-discovery`; GitHub remains the durable source of truth.
