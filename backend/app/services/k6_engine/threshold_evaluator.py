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

from typing import List

from app.schemas.enums import ResultClassification
from app.schemas.test_plan import TestPlan
from app.schemas.test_result import MetricsSummary, ThresholdViolation


def evaluate_threshold(metrics: MetricsSummary, plan: TestPlan) -> ResultClassification:
    ok = (
        metrics.p95_ms <= plan.thresholds.p95_latency_ms
        and metrics.error_rate <= plan.thresholds.error_rate
    )
    return ResultClassification.PASS if ok else ResultClassification.FAIL


def localize_failures(metrics: MetricsSummary, plan: TestPlan) -> List[ThresholdViolation]:
    """Derived evidence only -- WHERE and WHICH threshold was violated,
    never WHY (no root-cause claim). Does not change or duplicate
    evaluate_threshold()'s authoritative overall PASS/FAIL rule above; this
    only explains it (an empty list for a PASS is expected and correct)
    and additionally checks each per-endpoint entry, if any, against the
    SAME plan.thresholds (TestPlan has one threshold set, not
    per-endpoint ones, so this answers "would this endpoint alone have
    passed the plan's threshold", which is exactly the localization
    question -- not a new threshold concept)."""

    violations: List[ThresholdViolation] = []

    def _check(scope: str, p95_ms: float, error_rate: float) -> None:
        if p95_ms > plan.thresholds.p95_latency_ms:
            violations.append(
                ThresholdViolation(
                    scope=scope,
                    metric="p95_latency_ms",
                    observed=p95_ms,
                    threshold=float(plan.thresholds.p95_latency_ms),
                )
            )
        if error_rate > plan.thresholds.error_rate:
            violations.append(
                ThresholdViolation(
                    scope=scope,
                    metric="error_rate",
                    observed=error_rate,
                    threshold=plan.thresholds.error_rate,
                )
            )

    _check("overall", metrics.p95_ms, metrics.error_rate)
    for endpoint_metrics in metrics.per_endpoint:
        _check(endpoint_metrics.endpoint, endpoint_metrics.p95_ms, endpoint_metrics.error_rate)

    return violations
