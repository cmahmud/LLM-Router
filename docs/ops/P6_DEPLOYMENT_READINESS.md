---
title: "OmniRoute P6 ARM64 Deployment Readiness"
lastUpdated: 2026-09-22
---

# P6 ARM64 deployment readiness

This is an isolated deployment candidate procedure. It does not enable a
service, change public routing, modify Caddy/DNS/firewall rules, or certify
live FreeBuff access.

## Candidate layout

Use one immutable release directory per commit and keep SQLite data and
operator secrets outside the release tree:

```text
/home/ubuntu/projects/llm-router-dev/.claude/p6-runtime/<commit-sha>/
/home/ubuntu/projects/llm-router-dev/.claude/p6-data/
/home/ubuntu/projects/llm-router-dev/.claude/p6-env/router.env
```

The P6 checkout is
`/home/ubuntu/projects/llm-router-dev/.claude/worktrees/freebuff-p6-deployment-readiness`.
The shared `dev` checkout and MCP service are not used as the candidate
runtime.

## Runtime and install

The authoritative runtime is Node.js `>=22.22.2 <23 || >=24.0.0 <27`.
P6 uses the VPS's explicit `v24.13.0-linux-arm64` binary (`aarch64`, two
cores). Use the lockfile and workspace manifests:

```bash
export PATH=/path/to/node-v24.13.0-linux-arm64/bin:$PATH
cd /path/to/llm-router
npm ci --include=optional --no-audit --no-fund
npm run check:node-runtime
npm run check:native-deps
```

Do not copy `node_modules` between architectures. A deployment install must
allow the lockfile's approved native build scripts when a platform prebuild is
absent.

## Configuration

Create an environment file outside Git:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=23128
DASHBOARD_PORT=23128
API_PORT=23129
DATA_DIR=/home/ubuntu/projects/llm-router-dev/.claude/p6-data
REQUIRE_API_KEY=true
JWT_SECRET=<operator-generated-secret>
API_KEY_SECRET=<operator-generated-secret>
INITIAL_PASSWORD=<operator-generated-password>
OMNIROUTE_MEMORY_MB=2048
```

Check `ss -ltnp` before choosing a port. `/healthz` is lifecycle readiness,
`/livez` is process liveness, and `/api/health/ping` checks the database.
Use `/api/monitoring/health` only for an authenticated deep snapshot.

FreeBuff authentication remains the existing encrypted `freebuff` provider
connection API-key field (the bearer token accepted by the official endpoint),
configured through the normal admin/operator path. It is not a new environment
variable and must never be placed in this file or a test command line. Model
discovery uses the pinned official catalog with bounded last-known-good and
emergency fallback behavior.

## Build and startup

On this 2-core host use one Next worker and the measured heap budget:

```bash
export OMNIROUTE_USE_TURBOPACK=0
export CIRCLE_NODE_TOTAL=2
export OMNIROUTE_BUILD_MEMORY_MB=8192
npm run check:build-scope
npm run build
test -f .build/next/standalone/server.js
```

The build's native-dependency precheck and standalone assembler copy the
required platform assets. Preserve the complete standalone tree and its
`BUILD_SHA` sentinel; do not copy only `.next` or only JavaScript files.

Start only a loopback candidate on the test port:

```bash
set -a
. /home/ubuntu/projects/llm-router-dev/.claude/p6-env/router.env
set +a
cd /home/ubuntu/projects/llm-router-dev/.claude/p6-runtime/<commit-sha>
node dev/run-standalone.mjs
```

Verify and then stop the candidate with `kill -TERM <candidate-pid>`:

```bash
curl --fail --silent --show-error http://127.0.0.1:23128/healthz
curl --fail --silent --show-error http://127.0.0.1:23128/livez
curl --fail --silent --show-error http://127.0.0.1:23128/api/health/ping
```

Confirm the process tree exits, the port closes, no candidate lockfile or
orphan remains, and repeat once to prove restart behavior. Do not use `kill -9`
unless an operator is handling a stuck-process incident.

## Candidate systemd unit (not activated)

An operator may review a unit like this; P6 must not enable or start it:

```ini
[Unit]
Description=OmniRoute P6 candidate
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/projects/llm-router-dev/.claude/p6-runtime/<commit-sha>
EnvironmentFile=/home/ubuntu/projects/llm-router-dev/.claude/p6-env/router.env
ExecStart=/path/to/node-v24.13.0-linux-arm64/bin/node /home/ubuntu/projects/llm-router-dev/.claude/p6-runtime/<commit-sha>/dev/run-standalone.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
KillMode=mixed
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Replace the node path with the resolved, version-checked ARM64 binary from
the install step; do not silently use an unverified system Node binary.
Review the resolved path, user, ports, environment, and `DATA_DIR` before
activation. Never share the MCP port or production data directory.

## Rollback rehearsal

Before a candidate data change, stop writers and create a consistent snapshot:

```bash
bin/snapshot-data.sh --data-dir /home/ubuntu/projects/llm-router-dev/.claude/p6-data --label before-upgrade
```

Rollback is version selection: stop the candidate, retain its logs and release
directory, point the reviewed unit at the previous immutable commit directory,
and recheck health. Restore a data snapshot only for an approved migration
rollback. P6 runs no production migration or destructive restore. SQLite is a
single-writer topology; never run two candidates against the same `DATA_DIR`.

## Bounded live suite

The opt-in harness is `scripts/test/freebuff-live-smoke.mjs`. It requires an
already configured provider connection and explicit operator inputs:

```bash
FREEBUFF_LIVE_ENABLE=1 \
FREEBUFF_LIVE_GATEWAY_URL=http://127.0.0.1:23128 \
FREEBUFF_LIVE_GATEWAY_API_KEY=<gateway-key> \
FREEBUFF_LIVE_MODEL=<model-from-v1-models> \
node scripts/test/freebuff-live-smoke.mjs
```

For a deliberately unauthenticated loopback instance, use
`FREEBUFF_LIVE_ALLOW_UNAUTH=1`; never use that mode on a public interface. The
suite is sequential, limited to eight requests and 90 seconds, with bounded
per-request timeouts and no retries. It records only sanitized timestamps,
commit SHA, gateway origin, model IDs, protocol/result, latency, stream/frame
counts, tool-call ID/name and error categories. It never prints headers,
tokens, cookies, prompts, responses or upstream bodies.

If legitimate authorized access is not already available, report:

`LIVE FREEBUFF VALIDATION BLOCKED: AUTHORIZED ACCESS REQUIRED`

Third-party client smokes are individually labelled `TESTED`, `BLOCKED`, or
`NOT RUN`; this harness does not claim blanket compatibility. A successful
offline gate is **OFFLINE DEPLOYMENT READY**, not production-ready for live
FreeBuff.
