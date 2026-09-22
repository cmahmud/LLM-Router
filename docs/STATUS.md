---
title: "LLM-Router: Project Status"
lastUpdated: 2026-09-22
---

# Status — Packet 1 (P0) regression harness

**Phase 1 source audit and Packet 1 regression foundation are complete.** The Packet 1
implementation commit is `540fab15984d8eee372e8783a04b09fe5e5c4405` on `dev`.
Live FreeBuff-backed coding-client compatibility remains blocked by the access-contract question
below. This document does not certify deployment readiness.

## Completed

- Confirmed fork and upstream `release/v3.8.51` both at
  `3ee283bb944d6d62cc219f74317d5186942e1780`.
- Created `dev` from that commit through GitHub MCP. The original baseline remains untouched.
- Inspected native provider, executor, credential validation and existing five-test suite.
- Located all 147 case-insensitive FreeBuff references in the baseline: 17 primary files and
  130 localized mirrors. Inventory is in [FREEBUFF_AUDIT.md](FREEBUFF_AUDIT.md).
- Traced shared Chat/Responses/Anthropic routing, catalog merge behavior and resilience ownership.
- Compared all five requested reference implementations and their license situation; added current
  official FreeBuff source as the authoritative protocol comparison. Pinned source revisions in audit.
- Selected a small native provider module architecture; no new sidecar, Rust service or CLI wrapper.
- Defined session ownership, per-request runs, streaming finalization, atomic model discovery,
  non-mutating auth checks and bounded tests/implementation packets.
- Observed VPS aarch64, two CPUs, 11,924 MiB RAM and 193 GiB root filesystem. No router deployed.
- Added credential-free synthetic protocol fixtures under `tests/fixtures/freebuff/`.
- Added an injected-fetch harness under `tests/unit/helpers/freebuff-fixtures.ts` with deferred
  response bodies, call capture, fixture loading and restoration of the global fetch.
- Added deterministic P0 regressions for queued admission, missing instances, ignored START
  failures, caller-overridable metadata, early FINISH, and raw admission-error leakage. These
  assertions are intentionally red against the audited baseline and are the acceptance targets for
  P1–P3.

## In progress

P1 is next: introduce the typed transport/error boundary, read-only credential validation and
server-owned metadata. The P0 regressions remain the contract for that work. No live upstream
credential or client identity was used.

## Known issues and constraints

1. **Feasibility:** current official FreeBuff source explicitly detects and downgrades third-party
   toolsets/names/system prompts. Its comments prohibit this endpoint's third-party use. No permitted
   generic gateway contract has been established. Do not advertise requested-model fidelity or
   coding-client compatibility, spoof identity, rename tools for evasion or simulate ad engagement.
2. **Native defects:** legacy admission path; missing active-state validation; swallowed START
   failures; caller-overridable metadata; FINISH before stream completion; incomplete cleanup;
   raw upstream error leakage; absent session coordination and provider deadlines. Packet 1 now
   records each of these as a deterministic regression.
3. **Catalog:** nine static models, unknown-model fallback agent, unverified context/capability
   flags; generic model merging could preserve retired static rows without an explicit overlay.
4. **Authentication:** validator creates a session; all 409s accepted, 403s misclassified. No
   verified refresh-token mechanism. No credential values were read during the audit.
5. **Live environment:** conventional FreeBuff/Codebuff credential paths checked on the VPS and
   `~/.omniroute` were absent. This was a limited presence check, not an exhaustive credential search.
6. **Inherited quality state:** upstream has open base-red issue #13866 for docs/env drift at a
   different push range. Do not misreport that as a new FreeBuff defect.

## Tests and validation

- GitHub source/ref/tree/license inspection: performed; source evidence only.
- Exhaustive baseline content search on a pinned archive: performed; 147 matching files.
- Packet 1 fixture schema and harness files were added through GitHub MCP.
- The new lifecycle suite is expected to fail on the audited baseline by design; it was not run in
  the dependency-free VPS audit directory. No live network call, token, cookie or personal identifier
  was used.
- Full native/provider/integration suites, full build, native SQLite and production runtime
  validation: **not run**; application dependencies are not installed.
- Live inference, Codex/Pi/OpenCode/Claude client tests and ARM64 deployment validation: **not run**.
- The prior docs checks remain valid for the five Phase 1 documents; the Packet 1 status update
  references only files that now exist.

## Next steps

1. P1: typed transport/errors, read-only credential validation and metadata ownership.
2. P2: session/run leases, bounded admission, reconciliation and truthful finalization.
3. P3: lifecycle-aware streaming and real tool continuity through Chat.
4. P4: official catalog parsing, authoritative listing/resolution and capability limits.
5. P5: Responses/Anthropic gateway conformance and sanitized health; architecture review.
6. P6: full gates, ARM64 build, permitted bounded live tests and reversible deployment.

If no permitted FreeBuff interface is available, keep its live path blocked and use legitimate
OmniRoute providers for coding clients. The architecture documents remain useful for safe offline
hardening and any future authorized integration; a bridge cannot solve permission restrictions.

## Deployment state

**Not deployed; not ready for production FreeBuff use.** Packet 1 adds fixtures and tests only.
No services, firewall rules, ports, proxy settings, DNS, credentials or MCP connectivity changed.
The VPS audit material remains isolated in `/home/ubuntu/projects/llm-router-audit-20260922/`; it
is not an application checkout or running router. GitHub `dev` is the permanent project handoff.

## Packet 1 verification note

The synthetic fixtures are explicitly marked and contain no live credentials, cookies, user content,
or captured upstream responses. The harness uses injected fetch and a deferred Web Stream so later
packets can assert call order, body lifetime, cancellation and cleanup without real network access.
The current red assertions distinguish router behavior from the separate upstream restriction: they
exercise only mocked transport shapes and make no claim that a valid token would grant permitted
FreeBuff access.
