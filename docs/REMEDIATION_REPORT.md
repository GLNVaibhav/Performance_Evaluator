# Remediation Report — Security & Reproducibility Closure

> Final report of the remediation phase that closed the engineering-audit
> findings (see `docs/ENGINEERING_AUDIT.md`). The k6 redirect fix, its test
> suite, and the repository-hygiene fixes described here are part of this
> release. Verification numbers were re-confirmed at release time; see
> `docs/RELEASE_VERIFICATION.md`.

## Findings remediated

| # | Audit finding | Final status |
|---|---|---|
| 1 | k6 automatic redirects bypassed the application's SSRF/target-safety policy during the actual load phase | **PASS** — closed in `backend/app/services/k6_engine/script_renderer.py` |
| 2 | No automated tests proved the redirect security invariant | **PASS** — `backend/tests/k6_engine/test_redirect_security.py` |
| 3 | Execution-semantics preservation required (LIVE_K6 / REAL_PROBE / SIMULATION, status mappings, no simulation fallback) | **PASS** — full suites green, no behavior regressions |
| 4 | Reproducibility: broken `.env.example` / `docs/DEPLOYMENT.md` references, missing ignore rules, accidental files | **PASS** — references fixed, ignore rules added, `tmp_out.txt` removed |
| 5 | Product scope must not change | **PASS** — no new engines, modes, agents, or dashboards |
| 6 | Verification: focused → full suites with explained deltas and reported skips | **PASS** |
| 7 | Real k6 verification (pinned binary, canonical demo API) | **PASS** |
| 8 | Production-path E2E | **UNVERIFIED** — execution bridge unavailable (expired tunnel) |
| 9 | Secret hygiene of tracked content | **PASS** — no secrets in tracked source (demo credentials are intentionally published) |
| 10 | Final diff review | **PASS** — 9 changed files, all traceable to findings 1/2/4 |

## The security fix (k6 redirect handling)

**What was wrong (verified, not inferred):** the renderer emitted bare
`http.get(...)` / `http.post(...)` calls with no redirect configuration;
k6 v0.57.0 follows redirects by default (confirmed empirically: a bare
`http.get()` on a local 302 chased `Location: http://169.254.169.254/...`
with no validation). The application's SSRF policy only guarded probe
fetches (`src/convex/probe.ts`: manual hops, scheme + host validation,
`MAX_REDIRECTS = 3`) and OpenAPI fetches (`follow_redirects=False`). An
authorized target could therefore 302 the real k6 load to a destination
the policy never approved.

**How it works now** (all inside `script_renderer.py` — no new engine, no
CLI flags, no change to `target_url_safety.py`):

1. Every request the script makes — dispatch calls and the checkout/cart
   special case — is emitted as `requestWithRedirectPolicy(method, url,
   body, params)`. The wrapper injects `redirects: 0` into every request,
   so **k6 never auto-follows anything**.
2. Each 3xx is re-validated hop-by-hop before any follow, using the same
   policy classes as `target_url_safety.py`, embedded at render time
   (`ALLOW_PRIVATE` from `TARGET_SSRF_POLICY`, `TARGET_HOST` from the
   authorized `base_url`): http/https only, no embedded credentials,
   cloud-metadata/link-local destinations always blocked,
   private/loopback destinations blocked iff `TARGET_SSRF_POLICY=block_private`,
   at most `MAX_REDIRECTS = 3` hops — identical to the probe's hop policy.
3. **Fail-closed invariant:** a redirect host is followed only if it is
   (a) the authorized target host, or (b) an IP literal that passed the
   policy check completely. Any other hostname is refused — k6 has no DNS
   API, so the application's resolve-then-check cannot be replicated
   in-script. This is strictly stronger than the existing policy; no
   control was weakened and no site-specific exceptions were added.
4. A refused/over-limit redirect is returned **unfollowed**: the 3xx is
   the measured response, each intermediate hop's status is recorded
   exactly once, and an always-true `redirect_blocked_*` /
   `redirect_not_followed_*` check records why — honest evidence, zero
   traffic to the refused destination.

**Proof (real executions, local controlled servers only):** an allowed
redirect destination received load (>0 hits); blocked destinations (both
classes: private under `block_private`, and an unvalidatable hostname
under the default policy) received **exactly 0 hits** while the
authorized target was exercised normally; the 4th redirect's destination
received **0 hits** while all 3 allowed hops were followed; the executed
`script.js` contained only `redirects: 0` and zero bare `http.<method>(`
calls.

## Test evidence

| Check | Result | Exit |
|---|---|---|
| Focused redirect + renderer tests | **62 passed** | 0 |
| Full backend suite (`pytest -q -rs`) | **517 passed, 5 skipped, 0 failed** | 0 |
| Demo-API real-k6 file | **4 passed** | 0 |
| Convex/Bun (`bun test`) | **179 pass, 0 fail** | 0 |
| TypeScript (`bun tsc -b --noEmit`) | clean | 0 |

Baseline delta: 509 → 517 = exactly the 8 new tests. Three existing
renderer assertions were updated because they encoded the old vulnerable
emission (`http.get` / `http.post`); each edit is commented in the test
file. All 5 skips are pre-existing k6-detection predicates (reasons
reported every run; none are new).

**Real k6 verification:** `k6 version` → **k6 v0.57.0** (matches the
pin). Controlled execution against the canonical demo API: k6 started and
exited 0, `results.json` produced, FastAPI parsed it →
`summary_exists=True`, `threshold_status=PASS`, 50 real requests, all
`200`; the executed `script.js` contained the `redirects: 0` pin. No
simulation fallback exists on this path and none was introduced.

**Production E2E:** the configured bridge URL resolves to an expired
quick tunnel (DNS failure while general egress works) →
**PRODUCTION E2E UNVERIFIED — execution bridge unavailable.** No
workaround was invented and no new tunnel was opened.

## Repository hygiene

- Broken references fixed: 6 × `docs/DEPLOYMENT.md` →
  `docs/EXECUTION_PLANE_DEPLOYMENT.md`; Dockerfile deployment-contract
  pointer → `deploy/env.sample` (placeholders only, exists).
- Ignore rules added: `dist/`, `isolate/`, `*.tsbuildinfo`,
  `tmp_out.txt`; the 0-byte accidental `tmp_out.txt` was removed. No
  generated artifact is tracked.
- Tracked-content secret scan (205 files): no private keys, JWTs,
  bearer/API-key strings, or password assignments. Only intentionally
  published demo-account credentials (documented in the README) and a
  placeholder appear.
- Disclosure: during remediation, a faulty shell redaction filter
  printed Convex-deployment env **values** (bridge token, LLM key, JWT
  key) into the session transcript. They were never written to source.
  Rotation status is recorded in `docs/RELEASE_VERIFICATION.md`.

## Files changed in the remediation

| File | Why | Runtime behavior | Coverage |
|---|---|---|---|
| `backend/app/services/k6_engine/script_renderer.py` | finding 1 — redirect-safe wrapper + policy embedding | yes (rendered scripts) | 8 new tests + all 517 |
| `backend/tests/k6_engine/test_redirect_security.py` (new) | finding 2 | no | itself (5 real-k6 tests) |
| `backend/tests/k6_engine/test_script_renderer.py` | assertions encoded old emission | no | focused run |
| `backend/tests/k6_engine/test_script_renderer_auth_headers.py` | likewise | no | focused run |
| `Dockerfile.backend`, `docker-compose.yml`, `deploy/env.sample` | finding 3 — broken doc references | no (comments) | targets verified to exist |
| `.gitignore` | finding 4 — ignore build outputs | no | `git check-ignore` verified |
| `tmp_out.txt` (deleted) | finding 4 — accidental file | no | n/a |

## Remaining limitations

1. Production E2E unverified (bridge expired) — environment, not code.
2. Cross-host hostname redirects are refused during load (fail-closed by
   design; documented in the renderer's module docstring).
3. LLM key rotation requires the provider console (manual step remains).
4. Pre-existing test-infra debt: 5 k6-conditioned skips; no React
   component tests.

**Release decision:** READY WITH DOCUMENTATION CAVEATS — now discharged
via `docs/RELEASE_VERIFICATION.md` and the v1.0.0 tag.
