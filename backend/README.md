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

## Test

```
K6_BINARY="C:\Program Files\k6\k6.exe" .venv/Scripts/python.exe -m pytest -v
```

`tests/test_golden_path.py` is the Phase-1 golden test: it spins up a
throwaway stub target (`tests/stub_target/`, NOT the canonical demo API),
POSTs a real run against it, polls until `COMPLETED`, and asserts real
metrics come back. This exercises real k6 execution, not a mock.

## Current implementation status

- Domain schemas: `TestPlan` (boundary_search / fixed_load), `TestRun`
  (lifecycle state), `TestResult` (deterministic metrics + PASS/FAIL).
- SQLite persistence via SQLAlchemy; raw k6 artifacts live on disk under
  `artifacts/<run_id>/`, not in the DB.
- Run lifecycle: `POST /api/v1/runs` -> `QUEUED` -> background execution
  -> `RUNNING` -> `COMPLETED` / `EXECUTION_ERROR`.
- `app/services/performance_engine.py` defines the `PerformanceEngine`
  contract. `app/services/reference_k6_engine.py` is a **temporary**
  placeholder implementation (bare GET requests, k6's summary export, no
  steady-state windowing) that exists only to prove the pipeline works
  end to end with real k6 execution. It is not Developer 2's engine and
  should be deleted once that lands -- swap it in
  `app/services/engine_provider.py`.
- No LLM planner, no adaptive boundary-search engine, no auth, no frontend.
  Not in scope for this chunk.
