---
title: "LLM-Router: Project Status"
lastUpdated: 2026-09-22
---

# Status — Packet 2 (P1) transport, auth and metadata

**Phase 1, Packet 1 regression fixtures, and Packet 2 transport/auth/metadata hardening are
complete on `dev`.** Packet 2 is commit
`ae6b7b51888f0642484a34f7d0a5e6e27d70cefc`.

The implementation still does **not** certify permitted live FreeBuff model access or production
deployment readiness. No live FreeBuff credential was used.

## Completed

### Phase 1 and Packet 1

- Preserved the pristine OmniRoute `release/v3.8.51` baseline.
- Audited native routing, protocol translation, provider validation, FreeBuff behavior and relevant
  official upstream source.
- Selected the native OmniRoute integration path rather than a sidecar/proxy rewrite.
- Added credential-free synthetic FreeBuff fixtures and injected-fetch helpers.
- Added deterministic regressions covering admission, run start, metadata integrity, stream
  lifetime and error sanitization.

### Packet 2 (P1)

- Added a typed FreeBuff transport boundary under `open-sse/executors/freebuff/`:
  - bounded JSON reads;
  - Zod validation for admission, run-start and read-only user-probe responses;
  - explicit timeout, caller-abort, network, auth, forbidden, rate-limit, malformed-response and
    upstream-error classification;
  - `Retry-After` preservation;
  - the dedicated `/api/v1/freebuff/session/admission` endpoint with wallet spend limit zero;
  - fail-closed behavior for servers that do not expose the dedicated admission endpoint.
- Removed the hard-coded `codebuff/0.1.0 (darwin-arm64)` identity from FreeBuff requests.
- Removed the executor's Buffy system-prompt injection; valid caller content/tools are preserved
  instead of being modified to imitate a first-party client.
- Fixed session admission validation:
  - only a validated `status: "active"` response with a non-empty instance ID may advance;
  - legacy/malformed `state: "queued"`-shaped data fails closed;
  - typed current admission refusals remain distinct from malformed transport responses.
- Fixed run-start handling:
  - non-2xx START responses stop before chat dispatch;
  - malformed 2xx responses without a valid `runId` stop before chat dispatch.
- Hardened metadata ownership. Client metadata is preserved only for non-reserved keys; internal
  run/session/client/lifecycle/credit fields cannot overwrite router-owned values.
- Replaced mutating credential validation with read-only
  `GET /api/v1/me?fields=id`.
- Credential validation now distinguishes authentication failure, forbidden access, rate limiting,
  timeout/network failure and malformed successful responses without reflecting raw upstream bodies.
- Pre-stream chat failures are now surfaced through OmniRoute's structured/sanitized error envelope.
- Confirmed the existing OmniRoute request-scoped proxy context wraps provider execution, so the new
  transport inherits configured connection egress rather than introducing a second proxy layer.

## Current incomplete packet

Packet 3 (P2) — session/run lifecycle and concurrency — is next.

The remaining acceptance failure is intentional and isolated: a successful chat response still
schedules FINISH as soon as response headers arrive. Packet 3 must make completion follow the actual
body/stream lifecycle and add session coordination, cleanup and concurrency control.

## Known issues and constraints

1. **Permitted access remains unresolved.** Current official FreeBuff behavior detects/downgrades
   some third-party coding clients. This project will not spoof an approved client, rename tools for
   evasion, bypass access controls, evade quotas or claim requested-model fidelity without permitted
   upstream behavior.
2. **Lifecycle remains incomplete.** Session reuse/invalidation, stale-session handling, shared-state
   coordination, disconnect cleanup and finalization after body/stream completion belong to Packet 3.
3. **Streaming/tool continuity remains incomplete.** SSE termination, cancellation after headers,
   tool-call delta assembly, multi-tool continuation and reasoning stream fidelity belong to Packet 4.
4. **Catalog remains static.** Authoritative model discovery/capability handling belongs to Packet 5.
5. **Protocol conformance remains unverified.** Responses and Anthropic end-to-end behavior plus
   health reporting belong to Packet 6.
6. **ARM64 deployment is not yet validated.** The VPS has been used for development/runtime tests,
   but service install/start/restart/resource validation belongs to Packet 7.

## Tests and validation

Packet 2 was exercised on the ARM64 VPS using the isolated Node
`v24.13.0-linux-arm64` runtime already present from the audit.

- Packet 2 focused tests:
  - command:
    `node --import tsx/esm --test tests/unit/freebuff-provider.test.ts tests/unit/freebuff-transport.test.ts`
  - result: **17 passed, 0 failed**.
- Packet 1 lifecycle acceptance suite after Packet 2:
  - combined focused run: **23 passed, 1 failed** across 24 tests;
  - the only failure is
    `Freebuff P0 regression: FINISH waits for body consumption`;
  - that failure is the explicit Packet 3 target, not a Packet 2 regression.
- Open-SSE TypeScript regression gate:
  - `npm run check:open-sse-typecheck`
  - result: **0 errors; pass**.
- Core TypeScript:
  - `npm run typecheck:core`
  - result: **pass**.
- Targeted ESLint on changed TypeScript files using the repository suppression file:
  - result: **pass**.
- Prettier and `git diff --check`:
  - result: **pass**.
- Staged diff secret-pattern check:
  - no API keys, bearer tokens or private-key material detected.

### Live behavior

- Live FreeBuff inference: **not performed**.
- Live credential validation: **not performed**.
- Live requested-model fidelity: **not verified**.
- No token, cookie, session secret, auth file or personal identifier was committed.
- No service, firewall, DNS, port or proxy configuration was changed on the VPS.

## Current blocker

There is no implementation blocker for Packet 3.

The only external blocker is for later live FreeBuff claims: a permitted third-party integration
contract that allows the required client/protocol behavior has not been established. If legitimate
access cannot provide a requested model, the router must report/degrade that condition accurately
rather than bypassing the restriction.

## Next tasks

1. Packet 3 (P2): session/run lifecycle, bounded coordination, stale-session behavior, truthful
   completion, cancellation/disconnect cleanup and concurrency tests.
2. Packet 4 (P3): lifecycle-aware streaming, SSE correctness, cancellation and tool continuity.
3. Packet 5 (P4): authoritative model discovery and conservative cache/fallback behavior.
4. Packet 6 (P5): Chat/Responses/Anthropic conformance and sanitized provider health.
5. Packet 7 (P6): Linux ARM64 build/runtime/service validation and deployment documentation.

## Deployment state

**Not deployed and not production-ready for FreeBuff.**

Packet 2 is a stable, tested router milestone on `dev`, but the lifecycle, streaming/tool,
discovery, protocol-conformance and deployment packets remain open. The VPS checkout at
`/home/ubuntu/projects/llm-router-dev` is a development/test working tree; GitHub `dev` is the
permanent source of truth.
