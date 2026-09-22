---
title: "LLM-Router: Project Status"
lastUpdated: 2026-09-22
---

# Status — lifecycle and streaming integrated

Phase 1, P2 lifecycle and P3 streaming are integrated into `dev` at
`3497dfdc899f4f7fed69bb15a223a121174878de`. The fast-forward preserves the dependency order
from the validated `freebuff-p2-lifecycle` checkpoint (`afe024054bdc1d0513a49228142d7df77c95813b`)
through the validated `freebuff-p3-streaming` branch. PR #1 remains draft/open/unmerged and is
now an historical lifecycle review boundary; no merge commit or force-push was used.

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

## Validation gate

Validated in the detached ARM64 VPS worktree using the existing `v24.13.0-linux-arm64` runtime
and a read-only symlink to the installed dependencies:

- Focused FreeBuff command covering provider, transport, lifecycle, concurrency, run, session and
  stream tests: **55 passed, 0 failed**.
- `npm run check:open-sse-typecheck`: **0 errors; pass**.
- `npm run typecheck:core`: **pass**.
- Targeted ESLint: **pass**.
- Prettier check: **pass**.
- `git diff --check`: **pass**.
- Added expiry-while-leased regression after review found that concrete race; reran the full focused
  suite successfully.

## Live behavior and limitations

- Live FreeBuff inference: **not performed**.
- Live credential validation: **not performed**.
- Requested-model fidelity and third-party coding-client compatibility: **not verified**.
- No token, cookie, session secret, auth file or personal identifier was committed.
- No service, firewall, DNS, port or proxy configuration was changed on the VPS.
- The official foreign-client restriction remains a real feasibility boundary; no spoofing, tool
  renaming, engagement simulation, quota/account/IP evasion or other bypass was added.

## Next packet

Packet P4 is authoritative FreeBuff model discovery. Create the isolated branch
`freebuff-p4-model-discovery` from this `dev` head. Follow the audit/architecture decisions:
resolve one official source revision, parse only a constrained data subset without evaluating fetched
TypeScript, validate atomically, retain last-known-good data on failure, distinguish a valid empty
catalog from a refresh failure, and synchronize `/v1/models` with executor acceptance.

## Deployment state

**Not deployed and not production-ready for FreeBuff.** The primary VPS checkout at
`/home/ubuntu/projects/llm-router-dev` remains clean on `dev`; validation ran in
`/home/ubuntu/projects/llm-router-p3-streaming`. GitHub remains the durable source of truth.
