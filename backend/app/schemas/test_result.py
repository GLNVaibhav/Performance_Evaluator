from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.enums import ResultClassification


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


class TestResult(BaseModel):
    run_id: str
    metrics: MetricsSummary
    threshold_status: ResultClassification
    evaluated_at: datetime


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
    raw_output_path: Optional[str] = None
    summary_path: Optional[str] = None
    stdout_log_path: Optional[str] = None
    stderr_log_path: Optional[str] = None
    started_at: datetime
    finished_at: datetime
    error_message: Optional[str] = None
