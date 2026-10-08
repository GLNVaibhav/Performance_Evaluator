# Execution Plane Deployment Architecture (Phase 11; updated Phase "Real Performance Experimentation")

## Decision and rationale

The FastAPI + k6 execution plane **must run outside Convex and outside
Freebuff managed hosting** (hosting build is Node-only; Convex actions have no
subprocess; serverless Python functions cannot host a stateful k6 plane —
submit→poll→result requires a persistent process, persistent SQLite state,
and a persistent `artifacts/` disk across separate HTTP calls). The bridge
code in this repo treats the execution plane purely as an HTTPS service, so
the deployment target is a free choice:

- **Smallest compatible deployment**: any small Linux host/container with
  public ingress — Fly.io, Render, Railway, or a VPS — running
  `uvicorn app.main:app` from `backend/` with the k6 binary available
  (`K6_BINARY`), persistent disk for SQLite + `artifacts/`, and
  `EXECUTION_BRIDGE_TOKEN` set. Convex needs nothing but the URL + token.
- HTTPS terminates at the platform's proxy (Convex actions require HTTPS for
  non-localhost URLs).

## LIVE ingress achieved in this workspace (2026-09-27, verified)

The earlier "no ingress from this workspace" conclusion was **overturned** by
a zero-account Cloudflare quick tunnel (`cloudflared`, single static binary,
pure outbound HTTPS — no credentials, no inbound ports):

```
Convex cloud action (submit/poll/result)
   → https://<name>.trycloudflare.com        (public HTTPS ingress)
   → cloudflared (sandbox) → 127.0.0.1:8000  (FastAPI directly)
   → RealK6PerformanceEngine → real k6 v2.2.0
   → controlled demo API (127.0.0.1:8080)
```

Measured against this tunnel, the full product path passed end-to-end:
`scripts/product-path-validation.mjs` (14/14 points) and
`scripts/experiment-driver.mjs` (Phases 2–6, fixed-load A/B/C, weighted
3:1 multi-endpoint, controlled failure modes, one stress experiment,
history immutability) — every metric layer (raw k6 results.json → FastAPI
TestResult → Convex externalResult → Convex mapped metrics) verbatim-equal.

Reproduce locally:

```bash
# 1. execution plane (backend + controlled demo API), see repo conventions
#    backend: EXECUTION_BRIDGE_TOKEN=<secret> K6_BINARY=<path> uvicorn app.main:app --port 8000
#    demo:    uvicorn app.main:app --host 127.0.0.1 --port 8080
# 2. public ingress
/tmp/exec-plane/cloudflared tunnel --url http://127.0.0.1:8000 --no-autoupdate &
# 3. point the deployed Convex deployment at it
bun convex env set EXECUTION_BRIDGE_URL https://<name>.trycloudflare.com
bun convex env set EXECUTION_BRIDGE_TOKEN <secret>
# 4. validate
bun scripts/product-path-validation.mjs
```

Caveat (honest limitation): quick-tunnel hostnames are **ephemeral** — a new
`cloudflared` start yields a new `<name>.trycloudflare.com`, so
`EXECUTION_BRIDGE_URL` must be refreshed after every sandbox restart. A
stable deployment (Fly/Render/VPS, or a named Cloudflare tunnel with a
fixed hostname) removes this; the product needs no code change for either.

## What HAS been proven (real k6, real artifacts)

1. **Full execution chain, end-to-end, with real k6** (`scripts/e2e-live-k6.mjs`):
   approved plan → `serializePlan` → `makeBridgeClient().submit` → ingress
   relay (0.0.0.0) → bearer-authenticated FastAPI → RunManager →
   RealK6PerformanceEngine → **real k6 subprocess** → controlled demo API →
   `results.json` → backend metrics parser → `/result` → `mapBackendResult`.
   All 15 checks passed; every displayed metric asserted **equal to the raw k6
   results.json** (p50/p95/p99/avg/max/total/rps/error rate/failed count).
2. **Real k6 golden path** (`backend/tests/test_golden_path.py`) passes with
   the bundled k6 v2.2.0 binary.
3. **Failure semantics through the real product path**: with no reachable
   execution plane, the deployed Convex scheduled the bridge submission, the
   run ended `execution_error` with
   "execution backend unreachable … no simulation fallback" — **no simulated
   metrics were substituted** (Phase 5/8.G validated on the live system).

## Enabling LIVE_K6 in production (exact steps)

1. Deploy `backend/` on an ingress-capable host (see above) with:
   - `EXECUTION_BRIDGE_TOKEN=<secret>` (also set in Convex env)
   - `K6_BINARY=/path/to/k6`, `MAX_VUS`, `MAX_DURATION_S`,
     `K6_EXECUTION_TIMEOUT_S`, `TARGET_SSRF_POLICY` as required
   - persistent disk mounted at `ARTIFACTS_DIR` (+ SQLite `app.db`)
2. `bun convex env set EXECUTION_BRIDGE_URL https://<host>` and
   `bun convex env set EXECUTION_BRIDGE_TOKEN <secret>`
3. Approve a run in the Freebuff UI with the **LIVE_K6** execution mode.
4. Optional prod hardening: set `TARGET_SSRF_POLICY=block_private` for
   non-demo targets, put the service behind mTLS/IP allow-listing, and add a
   container `ulimit`/cgroup cap.

Until step 2 happens, the UI correctly shows LIVE_K6 as **unavailable** and
every failure path keeps the run honestly terminal — never simulation.
