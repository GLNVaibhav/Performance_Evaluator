# Integration Validation

## Baseline and environment

- `dev`: `f469ffd2dff251d2aeaff0fbd2b93d0fc77808bf` (merged PR #3)
- Validated branch: `feature/integration-qa`, created from the current `dev`.
- OS: Windows 10 Home Single Language (build 26200)
- Python: 3.14.4
- k6: `k6.exe v2.2.0 (windows/amd64)`

## Prerequisites

- A supported Python runtime. The declared pins are not compatible with the
  available Python 3.14; see [Known Limitations](#known-limitations).
- A real k6 executable available through `K6_BINARY`.

## Startup Instructions

The automated integration suite starts both services itself. For manual
inspection, use two terminals:

### Start Demo API

```powershell
cd demo-api
python -m uvicorn app.main:app --host 127.0.0.1 --port 8080
```

### Start Backend

```powershell
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## Required Environment Variables

```powershell
$env:K6_BINARY = '<path-to-k6-executable>'
```

`DATABASE_URL`, `ARTIFACTS_DIR`, and `K6_EXECUTION_TIMEOUT_S` are set to
temporary per-test values by the integration suite.

## Run Integration Tests

`backend/tests/integration/test_public_api_vertical_slice.py` starts the real
demo API and backend as separate Uvicorn processes on loopback ports. It uses
only `POST /api/v1/runs`, `GET /api/v1/runs/{id}`, and
`GET /api/v1/runs/{id}/result` for evaluator interaction. The engine then
fetches the live demo OpenAPI document and starts the real k6 executable.

```powershell
$env:K6_BINARY = '<path-to-k6-executable>'
python -m pytest backend/tests/integration -v -s
```

## Scenario Matrix

The test passed all required release scenarios:

| Scenario | Evidence |
| --- | --- |
| Healthy `/products` | `COMPLETED`, result HTTP 200, `PASS`, all metric fields, `results.json` present |
| Checkout bottleneck | Live mode switch; POST `/checkout`; `COMPLETED` plus threshold `FAIL`; measured p95 exceeded 100 ms; `results.json` present |
| Error injection | Live mode switch; `COMPLETED` plus threshold `FAIL`; measured error rate exceeded 1%; failed requests were positive; `results.json` present |
| Unavailable target | `EXECUTION_ERROR`, result HTTP 422, no `results.json` |
| Non-zero k6 exit | Test wrapper wrote a valid `results.json` then returned exit 7; API reported `EXECUTION_ERROR`, result HTTP 422, and never persisted a successful result |

## Failure Semantics Matrix

| Situation | Run status | Test result | Public result API |
| --- | --- | --- | --- |
| Healthy target | `COMPLETED` | Present, `PASS` | HTTP 200 |
| Slow target | `COMPLETED` | Present, `FAIL` | HTTP 200 |
| Error-prone target | `COMPLETED` | Present, `FAIL` | HTTP 200 |
| Unavailable target | `EXECUTION_ERROR` | Absent | HTTP 422 |
| Non-zero k6 exit | `EXECUTION_ERROR` | Absent | HTTP 422 |

## Artifact Contract

Artifacts are isolated at `<temporary state directory>/artifacts/<run_id>/`.
The integration test verifies the canonical `results.json` for all successful
k6 executions and verifies the special non-zero-exit artifact cannot produce
a result.

## OpenAPI Coverage

The live OpenAPI document contains GET `/products`, GET
`/products/{product_id}`, POST `/cart`, and POST `/checkout`. The item
parameter is named `product_id`, not the brief's illustrative `id`; this is a
contract naming variance, not an engine-resolution failure.

## Test commands and results

```powershell
$env:K6_BINARY = '<path-to-k6-executable>'
python -m pytest backend/tests -v
# 117 passed, 5 skipped

python -m pytest demo-api/tests -v
# 17 passed

python -m pytest backend/tests/integration -v -s
# 4 passed
```

`git diff --check` passed. The only tracked changes from QA are the integration
test and this report; virtual environments, SQLite files, logs, and artifacts
remain ignored.

## Known Limitations

The declared requirements do not install on the available Python 3.14.4:

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt -r demo-api\requirements.txt
```

fails while building `pydantic-core==2.27.2`, transitively pinned by
`pydantic==2.10.4`. After installing a compatible uncommitted QA-only
dependency set (`pydantic 2.13.5`, `SQLAlchemy 2.0.52`), all validation above
passed. The repository must pin a Python-3.14-compatible dependency set or
state and enforce a supported Python version before release approval.
