# Performance Engine Interface

This is the contract between the backend (Developer 1) and the performance
engine (Developer 2: k6 script templating, schema-aware payload generation,
subprocess execution, metrics analysis). The backend depends only on this
interface, defined in `app/services/performance_engine.py`:

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

The backend (`run_service.execute_run`) branches on this outcome exactly one way:

- **`summary_exists=True` and `metrics` and `threshold_status` are set**
  → treated as a legitimate performance result, *even if* `exit_code != 0`
  (e.g. k6's own native thresholds failed). `TestRun` → `COMPLETED`, a
  `TestResult` row is persisted with whatever `threshold_status` you give.
- **anything else** (`summary_exists=False`, or the engine raises) →
  treated as an actual execution failure. `TestRun` → `EXECUTION_ERROR`,
  `error_message` is stored, **no** `TestResult` is created. This must
  never be reinterpreted as a performance `FAIL` — the adaptive
  boundary-search engine (Phase 2) only ever sees clean PASS/FAIL results
  and would corrupt its search on a swallowed execution error.

Concretely: if k6 fails to start, the script has a syntax error, the target
is unreachable before any requests complete, or the process times out —
return `summary_exists=False` with `error_message` explaining why (or just
raise; the backend catches it and records the message). If the test ran to
completion and produced metrics, return `summary_exists=True` regardless of
whether thresholds passed.

## `threshold_status` is yours to compute, but must be deterministic

PASS/FAIL must never come from an LLM and must never be hardcoded by the
backend — the backend just persists whatever `threshold_status` the engine
returns. Compare `plan.thresholds` (`p95_latency_ms`, `error_rate`) against
your computed metrics using plain arithmetic.

## Steady-state windowing

For boundary-search / demo-mode runs, PASS/FAIL should generally be based
on the steady-state (hold) portion of the run, not the ramp-up. This means
you likely want to parse k6's raw per-request NDJSON output
(`k6 run --out json=raw.ndjson`) and filter by timestamp/tag rather than
relying solely on `k6 run --summary-export=summary.json`, which aggregates
over the entire run. `app/services/reference_k6_engine.py` (the current
Phase-1 placeholder) does **not** do this — it uses the plain summary
export — and is explicitly documented as a simplification to be replaced.

## MetricsSummary fields (deterministic, never LLM-authored)

`p50_ms`, `p95_ms`, `p99_ms`, `rps`, `total_requests`, `failed_requests`,
`error_rate` (0..1), `duration_s`.

## Wiring

`app/services/engine_provider.py` is the single place that decides which
`PerformanceEngine` implementation the API uses. Point it at your real
engine when it's ready; nothing in `app/api` or `run_service.py` needs to
change.
