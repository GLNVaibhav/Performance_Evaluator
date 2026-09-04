"""Deterministic PerformanceEngine test double + canned outcomes, used by
tests/test_failure_semantics.py to prove the run-lifecycle branching
(execution failure vs. performance failure vs. healthy success) without
depending on real k6. The real-k6 path is covered separately by
tests/test_golden_path.py -- this module must never replace that.
"""

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.schemas.enums import ResultClassification
from app.schemas.test_plan import TargetConfig, TestPlan
from app.schemas.test_result import EngineExecutionOutcome, MetricsSummary


def make_metrics(**overrides) -> MetricsSummary:
    base = dict(
        p50_ms=10.0,
        p95_ms=20.0,
        p99_ms=30.0,
        average_ms=12.0,
        max_ms=40.0,
        rps=5.0,
        total_requests=50,
        failed_requests=0,
        error_rate=0.0,
        duration_s=10.0,
    )
    base.update(overrides)
    return MetricsSummary(**base)


def performance_pass_outcome() -> EngineExecutionOutcome:
    now = datetime.now(timezone.utc)
    return EngineExecutionOutcome(
        exit_code=0,
        summary_exists=True,
        metrics=make_metrics(),
        threshold_status=ResultClassification.PASS,
        summary_path="fake/summary.json",
        stdout_log_path="fake/stdout.log",
        stderr_log_path="fake/stderr.log",
        started_at=now,
        finished_at=now,
    )


def performance_fail_outcome() -> EngineExecutionOutcome:
    """The test executed fully -- summary and metrics exist -- but the
    application did not meet its thresholds. A real performance result."""

    now = datetime.now(timezone.utc)
    return EngineExecutionOutcome(
        exit_code=99,  # e.g. k6's own native threshold failed -- still a real result
        summary_exists=True,
        metrics=make_metrics(p95_ms=5000.0),
        threshold_status=ResultClassification.FAIL,
        summary_path="fake/summary.json",
        stdout_log_path="fake/stdout.log",
        stderr_log_path="fake/stderr.log",
        started_at=now,
        finished_at=now,
    )


def execution_error_outcome(message: str = "k6 crashed before producing a summary") -> EngineExecutionOutcome:
    """No summary was produced -- an actual execution failure, never to be
    reinterpreted as a performance FAIL."""

    now = datetime.now(timezone.utc)
    return EngineExecutionOutcome(
        exit_code=-1,
        summary_exists=False,
        metrics=None,
        threshold_status=None,
        started_at=now,
        finished_at=now,
        error_message=message,
    )


class FakePerformanceEngine:
    """Implements the PerformanceEngine protocol with a canned outcome, or
    raises to simulate the engine itself blowing up."""

    def __init__(
        self,
        outcome: Optional[EngineExecutionOutcome] = None,
        raise_error: bool = False,
        raise_message: str = "simulated engine failure",
    ):
        self._outcome = outcome
        self._raise_error = raise_error
        self._raise_message = raise_message

    def execute(self, plan: TestPlan, target: TargetConfig, artifact_directory: Path) -> EngineExecutionOutcome:
        if self._raise_error:
            raise RuntimeError(self._raise_message)
        if self._outcome is None:
            raise AssertionError("FakePerformanceEngine used without an outcome or raise_error configured")
        return self._outcome
