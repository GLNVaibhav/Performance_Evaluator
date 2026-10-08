# Engineering Audit — Performance Evaluator (branch `dev`)

> Record of the independent engineering audit performed before release
> finalization, and the status of every finding at freeze time. Findings
> 1–6 were remediated in the remediation session documented in
> `docs/REMEDIATION_REPORT.md`; verification facts are restated in
> `docs/RELEASE_VERIFICATION.md`.

## Scope

Full engineering audit of `https://github.com/GLNVaibhav/Performance_Evaluator`
(branch `dev`): architecture, security posture, test evidence, execution
semantics, reproducibility, and repository hygiene. Audit-only mandate at
the time — no code was changed during the audit itself.

## Repository baseline (as found)

| Fact | Value (re-verified at freeze time) |
|---|---|
| Branch / HEAD | `dev` @ `2f300f9` ("Merge pull request #7 …") |
| Committed history | legacy backend snapshot + `demo-api/` + legacy frontend |
| Product source (`src/`, Convex control plane, UI, `docs/`, `scripts/`) | **uncommitted in the working tree** — critical baseline finding |
| Test suites present | backend (pytest), Convex (bun test), no React component tests |
| Working tree | extensive uncommitted modifications + untracked product files |

The uncommitted-product condition is the reason the release closure commit
deliberately commits the complete working product (minus ignored build
outputs) rather than only the remediation delta.

## Architecture inventory

- **A. Canonical Python/FastAPI execution plane** — `backend/app/`
  (FastAPI bridge + `RealK6PerformanceEngine` + SQLite + artifacts).
- **B. Freebuff/Convex control plane** — `src/convex/` (interpretation,
  compilation, approval, execution orchestration, boundary search,
  regression intelligence, AI analysis) + React UI in `src/`.
- **C. Controlled demo target** — `demo-api/` (deterministic failure modes:
  `normal`, `db_latency`, `checkout_bottleneck`, `error_injection`).
- **D. Legacy frontend** — `performance-evaluator-frontend/` (committed by
  PR #7; superseded by the Convex-native UI).
- **E. Test suites** — `backend/tests/` (pytest, incl. real-k6 executions),
  `demo-api/tests/`, `src/convex/*.test.ts`.
- **F. Deployment configuration** — `Dockerfile.backend`,
  `docker-compose.yml`, `deploy/env.sample`, `convex.json`,
  `docs/EXECUTION_PLANE_DEPLOYMENT.md`.

## Findings and final status

| # | Finding | Severity | Status at freeze |
|---|---|---|---|
| 0 | Entire product source uncommitted; no `origin/dev` synchronization for the product | Critical (process) | **RESOLVED** — release commit pushes the full working product to `origin/dev` |
| 1 | k6 followed HTTP redirects by default during the ACTUAL load phase; rendered scripts had no redirect configuration, bypassing the SSRF/target-safety policy that guarded probe and OpenAPI fetches | HIGH (security) | **RESOLVED** — redirect-safe wrapper in `script_renderer.py`, proven by real-k6 tests |
| 2 | No automated tests proved the redirect security invariant | HIGH | **RESOLVED** — `backend/tests/k6_engine/test_redirect_security.py` (8 tests, 5 real executions) |
| 3 | `Dockerfile.backend` referenced `.env.example` / `docs/DEPLOYMENT.md` as the deployment contract; `docs/DEPLOYMENT.md` does not exist | Reproducibility | **RESOLVED** — references fixed to `deploy/env.sample` and `docs/EXECUTION_PLANE_DEPLOYMENT.md` |
| 4 | Generated build outputs (`dist/`, `isolate/`, `*.tsbuildinfo`, `tmp_out.txt`) not ignored; one 0-byte accidental file present | Hygiene | **RESOLVED** — ignore rules added; `tmp_out.txt` removed |
| 5 | Production execution bridge (ephemeral tunnel) expired — production E2E unverifiable | Verification gap | **UNVERIFIED (open, environmental)** — documented in `docs/RELEASE_VERIFICATION.md` |
| 6 | k6-conditioned test skips (5) do not detect the installed k6 binary | Test-infra debt | **OPEN (accepted)** — identical skips before and after remediation; reasons reported every run |
| 7 | No React component/page tests; UI honesty claims are code-review-only | Coverage gap | **OPEN (accepted)** — documented limitation |

## Security posture (audit areas)

| Area | Posture |
|---|---|
| Target URL safety (DNS resolve-then-check, metadata always blocked, `TARGET_SSRF_POLICY`) | PASS |
| Probe redirect validation (manual hops, scheme + host validation, `MAX_REDIRECTS = 3`) | PASS |
| OpenAPI discovery fetch (no redirect following) | PASS |
| **k6 load-phase redirect handling** | **FAIL at audit → REMEDIATED** |
| Bridge authentication (optional bearer token, rate-limited admission) | PASS (local/dev posture documented) |
| Secret handling in scripts (env-only delivery, no secrets rendered into `script.js`) | PASS |
| Tracked-content secret scan | PASS (only intentionally published demo credentials) |
| DNS-rebinding / resolve-then-check atomicity | Documented accepted gap (pre-existing) |
| Production E2E security validation | UNVERIFIED (bridge unavailable) |

## Audit release decision (as delivered)

**ENGINEERING FIXES REQUIRED** — with a minimal freeze list: the k6
redirect fix, redirect regression tests, environment-reference fixes,
repository hygiene, and honest limitation documentation. Explicitly ruled
out: speculative refactoring, new features, and architecture changes.

All five freeze-list items were completed; see
`docs/REMEDIATION_REPORT.md` for evidence.
