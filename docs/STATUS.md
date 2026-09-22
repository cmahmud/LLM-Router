---
title: "LLM-Router: Project Status"
lastUpdated: 2026-09-22
---

# Status — architecture/audit milestone

**Phase 1 source audit and design complete. Production implementation has not started.**
READY FOR LUNA MAX for the ordered packets in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
Live FreeBuff-backed coding-client compatibility remains blocked by the access-contract question
below. This document describes this docs-only milestone; it does not certify deployment readiness.

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

## In progress

No implementation packet is active. Next engineer starts P0, records permitted access evidence,
and adds synthetic regressions before fixing behavior. Do not treat this document as authorization
to bypass the explicit upstream restrictions described in the architecture.

## Known issues and constraints

1. **Feasibility:** current official FreeBuff source explicitly detects and downgrades third-party
   toolsets/names/system prompts. Its comments prohibit this endpoint's third-party use. No permitted
   generic gateway contract has been established. Do not advertise requested-model fidelity or
   coding-client compatibility, spoof identity, rename tools for evasion or simulate ad engagement.
2. **Native defects:** legacy admission path; missing active-state validation; swallowed START
   failures; caller-overridable metadata; FINISH before stream completion; incomplete cleanup;
   raw upstream error leakage; absent session coordination and provider deadlines.
3. **Catalog:** nine static models, unknown-model fallback agent, unverified context/capability
   flags; generic model merging could preserve retired static rows without an explicit overlay.
4. **Authentication:** validator creates a session; all 409s accepted, 403s misclassified. No
   verified refresh-token mechanism. No credential values were read during the audit.
5. **Live environment:** conventional FreeBuff/Codebuff credential paths checked on the VPS and
   `~/.omniroute` were absent. This was a limited presence check, not an exhaustive credential search.
6. **Inherited quality state:** upstream has open base-red issue #13866 for docs/env drift at a
   different push range. Local baseline documentation gate attempted but stopped because dependencies
   are absent (`readCodeFacts` could not load/run tsx); do not misreport that as a new docs defect.

## Tests and validation

- GitHub source/ref/tree/license inspection: performed; source evidence only.
- Exhaustive baseline content search on a pinned archive: performed; 147 matching files.
- Full native/provider/integration suites: **not run**; application dependencies are not installed.
- Live inference, Codex/Pi/OpenCode/Claude client tests, full build, native SQLite and production
  runtime validation: **not run**. Reference projects' tests were inspected, not executed.
- `npm run check:docs-all` on the untouched archive: attempted using a temporary isolated Node
  v24.13.0 ARM64 runtime. Stopped at dependency-dependent docs count extraction (`tsx` missing).
  Node's version satisfies the inherited engine requirement; no global runtime was installed.
- Changed-document validation results are recorded in the final verification note below.

## Next steps

1. P0: establish a permitted upstream contract; add synthetic regressions and clearly label live
   blockers. No secret needs to be pasted into chat or Git.
2. P1: typed transport/errors, read-only credential validation and metadata ownership.
3. P2: session/run leases, bounded concurrency, reconciliation and cleanup; architecture review.
4. P3: lifecycle-aware streaming and real tool continuity through Chat.
5. P4: official catalog parsing, authoritative listing/resolution and capability limits.
6. P5: Responses/Anthropic gateway conformance and sanitized health; architecture review.
7. P6: full gates, ARM64 build, permitted bounded live tests and reversible deployment.

If no permitted FreeBuff interface is available, keep its live path blocked and use legitimate
OmniRoute providers for coding clients. The architecture documents remain useful for safe offline
hardening and any future authorized integration; a bridge cannot solve permission restrictions.

## Deployment state

**Not deployed; not ready for production FreeBuff use.** This milestone changes documentation only.
Runtime code is still the audited baseline, with the defects above. No services, firewall rules,
ports, proxy settings, DNS, credentials or MCP connectivity were changed.

VPS audit material is isolated in `/home/ubuntu/projects/llm-router-audit-20260922/`: pinned baseline
archive/extraction, reference inventory and temporary Node runtime for documentation checks. It is
not an application checkout or a running router. GitHub `dev` is the permanent project handoff.

## Final verification note

Five documents validated against the pinned baseline. Independent documentation checks passed:
`check:docs-frontmatter`, `check:env-doc-sync`, `check:deprecated-versions`, `check:doc-links`,
and `check:fabricated-docs`. The deprecated-version checker retains the same 90 pre-existing
warnings. The compiled-doc frontmatter gate excludes these root-level design docs, so their
frontmatter and fenced blocks were also checked explicitly. Proposed filenames in the handoff
are separated from existing-file claims; no gate allowlist or gate implementation was changed.
Formatting checked with Prettier 3.9.6. No application test/build/live result is implied.

The full `check:docs-all` aggregate remains blocked by missing application dependencies on the
untouched baseline. The inherited issue is reported separately; the local environment failure
is not evidence of a new code or documentation regression.
