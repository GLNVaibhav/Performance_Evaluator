from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field

from app.schemas.enums import ResultClassification
from app.schemas.test_plan import TestPlan


class EndpointMetrics(BaseModel):
    """Per-endpoint breakdown for one TestPlan.selected_endpoints entry --
    same HTTP stat shape as MetricsSummary, scoped by a k6 request tag.
    Built ONLY from k6's own tagged --summary-export stats
    (app/services/k6_engine/metrics_parser.py); never estimated or
    back-derived from the aggregate. An endpoint that received zero real
    requests during the run is simply absent from
    MetricsSummary.per_endpoint rather than reported with fabricated
    zeroes -- see docs/performance_engine_interface.md "Amendment:
    endpoint mix + per-endpoint evidence"."""

    endpoint: str
    method: str
    total_requests: int
    p50_ms: float
    p95_ms: float
    p99_ms: float
    average_ms: float
    max_ms: float
    rps: float
    failed_requests: int
    error_rate: float = Field(ge=0, le=1)


class MetricsSummary(BaseModel):
    """Canonical MVP metrics contract. Values are whatever the performance
    engine computed (from k6's --summary-export) -- the backend never
    calculates percentiles/averages itself, only stores and serves them."""

    p50_ms: float
    p95_ms: float
    p99_ms: float
    average_ms: float
    max_ms: float
    rps: float
    total_requests: int
    failed_requests: int
    error_rate: float = Field(ge=0, le=1)
    duration_s: float
    # Additive: empty for any plan/engine that predates endpoint-mix
    # tagging, or for a single-endpoint plan's aggregate-equals-breakdown
    # case is still populated for consistency. Never required -- existing
    # callers constructing MetricsSummary() without this field are
    # unaffected (defaults to []).
    per_endpoint: List[EndpointMetrics] = Field(default_factory=list)


class ThresholdViolation(BaseModel):
    """One deterministic threshold breach, derived (never estimated) by
    comparing already-computed metrics against the plan's own thresholds --
    see app/services/k6_engine/threshold_evaluator.py::localize_failures().
    `scope` is either the literal string "overall" or one of
    MetricsSummary.per_endpoint[].endpoint. This is derived evidence, not a
    root-cause claim: it says WHERE and WHICH threshold, never WHY."""

    scope: str
    metric: str
    observed: float
    threshold: float


class ArtifactRefs(BaseModel):
    """Paths to artifacts the engine already produces on disk for a
    COMPLETED run (app/services/k6_engine/k6_runner.py,
    app/services/k6_engine/engine.py). Each field is populated only if the
    file actually exists -- never a fabricated/guessed path."""

    script_path: Optional[str] = None
    results_json_path: Optional[str] = None
    stdout_log_path: Optional[str] = None
    stderr_log_path: Optional[str] = None


class TestResult(BaseModel):
    run_id: str
    metrics: MetricsSummary
    threshold_status: ResultClassification
    evaluated_at: datetime
    # --- Additive result-model enrichment (endpoint mix + per-endpoint
    # evidence phase). Assembled by the API layer (routes_runs.py) from
    # data already persisted/produced elsewhere -- no new collection, no
    # LLM, no speculation. See docs/performance_engine_interface.md. ---
    target_base_url: Optional[str] = None
    plan: Optional[TestPlan] = None
    threshold_violations: List[ThresholdViolation] = Field(default_factory=list)
    artifacts: Optional[ArtifactRefs] = None


class EngineExecutionOutcome(BaseModel):
    """Return contract for PerformanceEngine.execute(). See
    docs/performance_engine_interface.md for the full contract, especially
    the summary_exists distinction between a legitimate performance result
    (thresholds failed, but the test ran) and an actual execution failure.
    """

    exit_code: int
    summary_exists: bool
    metrics: Optional[MetricsSummary] = None
    threshold_status: Optional[ResultClassification] = None
    # Additive: computed alongside threshold_status (same place, same
    # inputs) so derived evidence is produced once, at execution time, by
    # the engine -- never recomputed later by the API layer reaching back
    # into k6_engine internals. Empty for a PASS, or when summary_exists
    # is False (nothing to localize for an execution failure).
    threshold_violations: List[ThresholdViolation] = Field(default_factory=list)
    raw_output_path: Optional[str] = None
    summary_path: Optional[str] = None
    stdout_log_path: Optional[str] = None
    stderr_log_path: Optional[str] = None
    started_at: datetime
    finished_at: datetime
    error_message: Optional[str] = None
