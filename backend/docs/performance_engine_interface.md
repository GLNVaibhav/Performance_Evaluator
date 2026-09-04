# Performance Engine Interface

**Status: frozen for MVP integration** (reviewed by Dev-3). `TestPlan`
(`app/schemas/test_plan.py`) is the central contract of the whole system —
`boundary_search` means one VU-level experiment, `fixed_load` means one
fixed workload. Neither is ever a multi-stage stress ladder inside a
single k6 invocation.

This is the contract between the backend (Developer 1) and the performance
engine (Developer 2: k6 script templating, schema-aware payload generation,
subprocess execution, metrics analysis). The backend depends only on this
interface, defined in `app/services/performance_engine.py`. Do not change
this interface for a hypothetical need — only for a genuine blocking
incompatibility discovered while integrating the real engine.

```python
class PerformanceEngine(Protocol):
    def execute(
        self,
        plan: TestPlan,
        target: TargetConfig,
        artifact_directory: Path,
    ) -> EngineExecutionOutcome: ...
```

- `plan` — a validated `TestPlan` (`app/schemas/test_plan.py`): either
  `BoundarySearchPlan` (single `target_vus`, `ramp_duration` + `hold_duration`)
  or `FixedLoadPlan` (single `target_vus`, `duration`). Never JavaScript.
- `target` — currently just `{ base_url: str }`. No auth in Phase 1.
- `artifact_directory` — a directory the backend has already created and
  uniquely owns for this run (`artifacts/<run_id>/`). The engine should
  write whatever it needs here (rendered script, raw k6 output, k6 summary,
  logs) and reference those paths back in the outcome. The backend does not
  clean this up or inspect its contents beyond the paths returned.

## Return contract: `EngineExecutionOutcome`

```python
class EngineExecutionOutcome(BaseModel):
    exit_code: int
    summary_exists: bool
    metrics: Optional[MetricsSummary] = None
    threshold_status: Optional[ResultClassification] = None
    raw_output_path: Optional[str] = None
    summary_path: Optional[str] = None
    stdout_log_path: Optional[str] = None
    stderr_log_path: Optional[str] = None
    started_at: datetime
    finished_at: datetime
    error_message: Optional[str] = None
```

## The one rule that actually matters: execution failure vs. performance failure

**Amended by the Dev-3 gate review (BLOCKER 2, commit `585a177`).** The
original version of this doc said a present results artifact was a
legitimate result "even if `exit_code != 0`". That was wrong and has been
fixed in the real engine: a non-zero k6 exit code is *always* an execution
failure, full stop — a `results.json` that happens to exist on disk (e.g.
from a script/runtime error partway through, or the process being killed
after partially flushing output) never overrides a failed process.

The backend (`run_service.execute_run`) branches on this outcome exactly one way:

- **`exit_code == 0` and a usable results artifact exists** → the engine
  parses metrics and evaluates thresholds, returning `summary_exists=True`
  with `metrics` and `threshold_status` set. This is a legitimate
  performance result, whether `threshold_status` comes out `PASS` or
  `FAIL`. `TestRun` → `COMPLETED`, a `TestResult` row is persisted with
  whatever `threshold_status` you give.
- **anything else** — `exit_code != 0` (regardless of whether a results
  artifact exists), a missing/malformed results artifact, or the engine
  raises — → `summary_exists=False`, `metrics=None`, `threshold_status=None`.
  Treated as an actual execution failure. `TestRun` → `EXECUTION_ERROR`,
  `error_message` is stored, **no** `TestResult` is created. This must
  never be reinterpreted as a performance `FAIL` — the adaptive
  boundary-search engine (Phase 2) only ever sees clean PASS/FAIL results
  and would corrupt its search on a swallowed execution error.

Concretely: if k6 fails to start, the script has a syntax error, the
process exits non-zero for any reason (including a crossed k6-native
threshold, if one is ever configured), the target is unreachable before
any requests complete, or the process times out — return
`summary_exists=False` with `error_message` explaining why (or just raise;
the backend catches it and records the message). Only return
`summary_exists=True` when the process exited `0` *and* you have real
metrics to report.

## `threshold_status` is yours to compute, but must be deterministic

PASS/FAIL must never come from an LLM and must never be hardcoded by the
backend — the backend just persists whatever `threshold_status` the engine
returns. Compare `plan.thresholds` (`p95_latency_ms`, `error_rate`) against
your computed metrics using plain arithmetic.

## Canonical MVP result artifact: k6 summary-export (frozen)

The frozen MVP execution contract is:

```
k6 execution
    ↓
--summary-trend-stats="min,med,avg,max,p(50),p(95),p(99)"
    ↓
--summary-export=results.json
```

This `--summary-export` JSON is the canonical MVP result artifact. Every
`MetricsSummary` field maps directly from it — the engine must not compute
percentiles itself, only read what k6 already computed:

| MetricsSummary field | k6 summary source |
|---|---|
| `p50_ms` | `p(50)` (fall back to `med` if absent) |
| `p95_ms` | `p(95)` |
| `p99_ms` | `p(99)` |
| `average_ms` | `avg` |
| `max_ms` | `max` |
| `rps` | `http_reqs` rate |
| `total_requests` | `http_reqs` count |
| `error_rate` | `http_req_failed` value/rate |
| `failed_requests` | `error_rate * total_requests` |

Note k6's `--summary-export` layout has varied slightly across versions
(stats directly on the metric object vs. nested under a `values` key) —
handle both defensively (`app/services/k6_engine/metrics_parser.py` does).

**Raw NDJSON output (`k6 run --out json=raw.ndjson`) is NOT required for
MVP.** It is optional future/diagnostic tooling only. This is a deliberate
scope decision, not an oversight: boundary search is a sequence of
*independent* k6 invocations, one per experiment (e.g. 100 VUs → one run →
one summary; 500 VUs → a separate run → a separate summary; 1000 VUs →
another separate run → another separate summary). There is no multi-stage
ladder inside one invocation that would need steady-state windowing across
raw per-request records. Do not implement raw NDJSON parsing or windowing
for the current MVP.

## MetricsSummary fields (deterministic, never LLM-authored)

`p50_ms`, `p95_ms`, `p99_ms`, `average_ms`, `max_ms`, `rps`,
`total_requests`, `failed_requests`, `error_rate` (0..1), `duration_s`.
These are persisted end-to-end (`TestResultRecord` columns) and returned
verbatim by `GET /api/v1/runs/{id}/result` — no field is silently dropped
between the engine outcome and the API response.

## Workload safety limits (enforced before execution, not by k6)

`app/services/workload_limits.py` enforces `MAX_VUS` and `MAX_DURATION_S`
(env-configurable, see `app/core/config.py`) against every `TestPlan`
before it is persisted or reaches the engine — for `boundary_search`,
`ramp_duration + hold_duration` counts as the plan's total duration; for
`fixed_load`, `duration` does. This is separate from
`K6_EXECUTION_TIMEOUT_S`, which is a wall-clock ceiling on the k6
*process* (protects against a hung run), not a workload-size limit. The
engine can assume any plan it receives has already passed this gate — it
does not need to re-validate VU counts or durations itself.

## Wiring

**Status: complete.** `app/services/engine_provider.py` points at
`RealK6PerformanceEngine` (`app/services/k6_engine/engine.py`).
`reference_k6_engine.py` has been deleted — it was a temporary Phase-1
placeholder, never a second production-selectable engine architecture.
Full backend test suite (77 tests) and the real k6 integration suite
against the canonical demo API both pass against the real engine.

## Target environments

MVP targets are **local / staging / sandbox only**. Production load
testing is explicitly out of scope for the current phase — there is no
target-authorization workflow, rate limiting, or safety review for hitting
a real production service, and none should be assumed.
