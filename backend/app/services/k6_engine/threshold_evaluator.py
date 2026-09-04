"""Frozen threshold semantics (section 6):

    PASS  iff  metrics.p95_ms <= thresholds.p95_latency_ms
          AND  metrics.error_rate <= thresholds.error_rate
    else  FAIL

Deliberately does NOT read k6's own per-metric `thresholds` verdict field
from results.json -- that field's boolean meaning ("crossed" vs "passed")
has varied/been ambiguous across k6 versions and is easy to invert by
accident. Computing PASS/FAIL directly from plan.thresholds vs. the
already-extracted MetricsSummary with plain arithmetic sidesteps that
entirely and is the only thing section 6 actually requires.
"""
from __future__ import annotations

from app.schemas.enums import ResultClassification
from app.schemas.test_plan import TestPlan
from app.schemas.test_result import MetricsSummary


def evaluate_threshold(metrics: MetricsSummary, plan: TestPlan) -> ResultClassification:
    ok = (
        metrics.p95_ms <= plan.thresholds.p95_latency_ms
        and metrics.error_rate <= plan.thresholds.error_rate
    )
    return ResultClassification.PASS if ok else ResultClassification.FAIL
