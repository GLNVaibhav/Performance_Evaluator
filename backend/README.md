# Backend (Developer 1)

FastAPI service: run lifecycle, domain contracts, persistence, and the
integration boundary with the performance engine. See
`docs/performance_engine_interface.md` for the contract Developer 2's
engine must implement.

## Setup

```
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
```

Requires the [k6](https://k6.io) binary. It does not need to be on PATH --
point `K6_BINARY` at it if not:

```
set K6_BINARY=C:\Program Files\k6\k6.exe
```

Workload safety limits (`app/services/workload_limits.py`) and the k6
execution timeout are also env-configurable:

| Variable | Default | Meaning |
|---|---|---|
| `MAX_VUS` | `2000` | Max `target_vus` a `TestPlan` may request |
| `MAX_DURATION_S` | `90` | Max planned workload duration in seconds (`duration`, or `ramp_duration + hold_duration`) |
| `K6_EXECUTION_TIMEOUT_S` | `120` | Wall-clock ceiling on the k6 subprocess itself -- a process safety net, distinct from `MAX_DURATION_S` |

Defaults are sized for local/staging/sandbox use on a single developer
machine, not production load testing.

## Run

```
.venv/Scripts/python.exe -m uvicorn app.main:app --reload
```

Then, e.g.:

```
curl -X POST http://127.0.0.1:8000/api/v1/runs \
  -H "Content-Type: application/json" \
  -d "{\"plan_id\": \"baseline_checkout\", \"target\": {\"base_url\": \"http://127.0.0.1:8080\"}}"

curl http://127.0.0.1:8000/api/v1/runs/<run_id>
curl http://127.0.0.1:8000/api/v1/runs/<run_id>/result
```

`target.base_url` must point at a running target app (e.g. the demo
e-commerce API, once it exists). `demo_plans/` holds hardcoded TestPlans
for Phase 1 -- no LLM planner dependency yet.

`POST /api/v1/intents/compile` additively accepts a higher-level
`UniversalPerformanceIntent` (what a user wants, possibly incomplete) and
deterministically compiles it into a `TestPlan`, or returns a structured
`NEEDS_CLARIFICATION`/`INVALID` result -- it never executes anything. See
`docs/ai_intent_architecture.md`.

## Test

```
K6_BINARY="C:\Program Files\k6\k6.exe" .venv/Scripts/python.exe -m pytest -v
```

`tests/test_golden_path.py` is the Phase-1 golden test: it spins up a
throwaway stub target (`tests/stub_target/`, NOT the canonical demo API),
POSTs a real run against it, polls until `COMPLETED`, and asserts real
metrics come back. This exercises real k6 execution, not a mock.

## Current implementation status

- Domain schemas: `TestPlan` (`boundary_search` = one VU-level experiment,
  `fixed_load` = one fixed workload; central contract, frozen for MVP
  integration), `TestRun` (lifecycle state), `TestResult` (deterministic
  metrics + PASS/FAIL).
- Canonical MVP metrics: `p50_ms`, `p95_ms`, `p99_ms`, `average_ms`,
  `max_ms`, `rps`, `total_requests`, `failed_requests`, `error_rate`,
  `duration_s` -- persisted end-to-end (engine outcome -> DB -> API), never
  computed by the backend itself.
- Canonical MVP result artifact is k6's `--summary-export` JSON (see
  `docs/performance_engine_interface.md`). Raw NDJSON / steady-state
  windowing is explicitly out of scope for MVP -- boundary search runs one
  independent k6 invocation per experiment, so there's no in-run ladder to
  window.
- Authoritative, server-side workload limits (`MAX_VUS`, `MAX_DURATION_S`)
  enforced before a plan is persisted or reaches k6 -- never left to k6 or
  the subprocess timeout alone.
- SQLite persistence via SQLAlchemy; raw k6 artifacts live on disk under
  `artifacts/<run_id>/`, not in the DB.
- Run lifecycle: `POST /api/v1/runs` -> `QUEUED` -> background execution
  -> `RUNNING` -> `COMPLETED` / `EXECUTION_ERROR`. Execution failure
  (no summary artifact) is never conflated with a performance FAIL
  (summary + metrics exist, thresholds just weren't met) -- see the tests
  in `tests/test_failure_semantics.py`.
- `app/services/performance_engine.py` defines the `PerformanceEngine`
  contract (frozen; do not change without a genuine blocking
  incompatibility). `app/services/reference_k6_engine.py` is a
  **temporary** placeholder implementation (bare GET requests, k6's
  summary export) that exists only to prove the pipeline works end to end
  with real k6 execution. It is not Developer 2's engine, must not gain
  product functionality, and should be deleted once that lands -- swap it
  in `app/services/engine_provider.py`.
- MVP targets are local/staging/sandbox only; production load testing is
  out of scope.
- No LLM planner, no adaptive boundary-search engine, no auth, no
  frontend, no OpenAPI parser. Not in scope for this chunk.
- `app/schemas/intent.py` + `app/services/intent_compiler.py` add a
  deterministic `UniversalPerformanceIntent -> TestPlan` compiler
  (`POST /api/v1/intents/compile`) so a future AI/NLP layer has a safe,
  validated target to compile into. No AI/LLM provider is integrated by
  this -- see `docs/ai_intent_architecture.md`.
