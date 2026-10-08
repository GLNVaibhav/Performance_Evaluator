# Perforso — Autonomous Performance Evaluator

"Describe the performance goal. The system plans, runs, investigates, and explains the test."

A working, end-to-end performance evaluation platform: natural-language objectives are
interpreted into a strict intent schema, **deterministically compiled** into a validated
k6-style load plan, gated behind an **explicit human approval**, executed with staged
traffic ingestion, and explained with threshold verdicts, breaking-point localization,
and AI analysis.

## The workflow contract (preserved from `dev`)

```
intent → compile → approve → execute → result
```

1. **Interpret** — an LLM (OpenRouter / any OpenAI-compatible API) maps your sentence onto a
   `UniversalPerformanceIntent`. Falls back to a deterministic keyword interpreter when no key
   is configured. Adversarial or vague requests are rejected, never guessed.
2. **Compile** — pure deterministic gate (`src/convex/compiler.ts`, port of
   `backend/app/services/intent_compiler.py`). Returns `READY` / `NEEDS_CLARIFICATION` /
   `INVALID`. Compiling never executes anything. Workload limits (`MAX_VUS`, `MAX_DURATION_S`)
   are enforced here.
3. **Approve** — the compiled plan (VUs, durations, endpoints, thresholds, assumptions) is
   shown for human review. Nothing runs until you approve, and the target URL is confirmed here.
4. **Execute** — a background action first attempts a **bounded real-traffic probe**
   (`src/convex/probe.ts`): measured GET requests (≤30 requests, ≤4 in-flight, ≤8s, polite
   User-Agent) with real latency/status/error evidence streamed per-second into Convex. If the
   target is unreachable, execution falls back to the deterministic k6-style closed model
   (`src/convex/engine.ts`) and the run is explicitly labelled `simulation`. The dashboard
   shows the run **live** via reactive subscriptions.
5. **Explain** — threshold evaluation (`threshold_evaluator` port) plus the AI analyzer
   (`ai_analyzer` port) produce a PASS/FAIL verdict, violations, breaking point (simulation
   mode), and remediation recommendations — mode-aware, so real-probe runs never claim
   saturation they didn't measure.

## Stack

- **Frontend:** React 19 + Vite + Tailwind + shadcn-style components, custom SVG charts
- **Backend:** Convex (reactive database + background actions), Convex Auth (password)
- **LLM:** OpenAI-compatible chat completions via `fetch` — no SDK
- **Legacy/reference code:** `backend/` (FastAPI + real k6 binary) and `demo-api/` (the
  canonical demo target) from the `dev` branch are preserved unchanged

## Environment

| Key | Required | Purpose |
|---|---|---|
| `VITE_CONVEX_URL` | auto | Set by `convex dev` |
| `LLM_API_KEY` | no | Enables the LLM interpreter + AI analyzer (e.g. OpenRouter key) |
| `LLM_BASE_URL` | no | Defaults to `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | no | Defaults to `openai/gpt-4o-mini` |

Without `LLM_API_KEY` the product still works end-to-end via the deterministic interpreter
and analyzer.

## Try it

### Demo admin account

A demo administrator account is seeded on the cloud deployment for testing:

```
email:    admin@perforso.dev
password: Perforso-Demo-2026!
```

Sign in at `/auth` with those credentials (or create your own account — sign-up is open).

### Running an evaluation in the UI

1. Sign in → **New evaluation**
2. Describe the mission, e.g. *"Baseline /products with 50 users for 30s, p95 under 400ms"*
   or *"Stress https://example.com up to 200 users — find the breaking point"*
3. Set the target base URL (any public URL, or the bundled demo API at
   `http://127.0.0.1:8080`; cloud metadata hosts are always blocked)
4. Review the compiled plan → **Approve & execute**
5. Watch live traffic ingest, then read the verdict, breaking point, and analysis

The engine is **probe-first**: reachable targets receive real (bounded, polite) HTTP traffic
and every number in the report is measured — p50/p95/p99 from actual response latencies,
errors from actual status codes/network failures. Unreachable targets fall back to the
deterministic k6-style simulation, and the run record + UI badge always tell you which mode
produced the result (`engineMode: "real" | "simulation"`).

### Headless evaluation runs

`scripts/engine-eval.mjs` drives the deployed backend through the same API the UI uses
(interpret → compile → approve/create → poll) and prints a report:

```bash
bun scripts/engine-eval.mjs
# overrides:
#   PERFSO_DEPLOY_URL / PERFSO_EMAIL / PERFSO_PASSWORD
```

A recent batch run across three real sites (all `engineMode=real`, PASS, LLM analyzer —
30 measured requests each):

| Target | Test | p50 | p95 | p99 | Error rate |
|---|---|---|---|---|---|
| example.com | baseline | 7ms | 10ms | 20ms | 0.00% |
| convex.dev | stress | 45ms | 114ms | 231ms | 0.00% |
| perfev.freebuff.app | baseline | 9ms | 52ms | 160ms | 0.00% |

## Branch model (upstream repo)

- `main` — stable / demo-ready
- `dev` — integration branch (FastAPI backend + demo API + polling frontend)
- this root app — the Freebuff-native, auth'd, real-time product experience
