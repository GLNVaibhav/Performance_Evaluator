"""k6 results.json -> MetricsSummary. No percentile math here -- k6 already
computed everything; this module only extracts and relabels (section 5).

Handles both known --summary-export layouts defensively (flat stats
directly on the metric object, vs. nested under a 'values' key) since the
layout has varied across k6 versions -- see performance_engine_interface.md.

Missing required metrics is an execution failure, not a metric silently
returned as zero (section 15, section 5).
"""
from __future__ import annotations

import json
from pathlib import Path

from app.schemas.test_result import MetricsSummary


class MetricsParseError(RuntimeError):
    """results.json is missing, malformed, or missing a metric required by
    MetricsSummary. Always an execution failure -- never converted to a
    performance FAIL (section 6, Case C)."""


def _metric_stats(metrics: dict, name: str) -> dict:
    entry = metrics.get(name)
    if entry is None:
        return {}
    values = entry.get("values")
    return values if isinstance(values, dict) else entry


def parse_results(results_path: Path, duration_s: float) -> MetricsSummary:
    try:
        data = json.loads(results_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise MetricsParseError(f"could not read/parse {results_path}: {exc}") from exc

    metrics = data.get("metrics")
    if not isinstance(metrics, dict):
        raise MetricsParseError(f"{results_path} has no usable 'metrics' object")

    duration_stats = _metric_stats(metrics, "http_req_duration")
    reqs_stats = _metric_stats(metrics, "http_reqs")
    failed_stats = _metric_stats(metrics, "http_req_failed")

    def _require(stats: dict, *keys: str, metric_name: str) -> float:
        for key in keys:
            if key in stats:
                return float(stats[key])
        raise MetricsParseError(
            f"required metric missing: none of {keys} present under '{metric_name}' in {results_path}"
        )

    p50_ms = _require(duration_stats, "p(50)", "med", metric_name="http_req_duration")
    p95_ms = _require(duration_stats, "p(95)", metric_name="http_req_duration")
    p99_ms = _require(duration_stats, "p(99)", metric_name="http_req_duration")
    average_ms = _require(duration_stats, "avg", metric_name="http_req_duration")
    max_ms = _require(duration_stats, "max", metric_name="http_req_duration")

    total_requests = int(_require(reqs_stats, "count", metric_name="http_reqs"))
    rps = _require(reqs_stats, "rate", metric_name="http_reqs")

    error_rate = _require(failed_stats, "value", "rate", metric_name="http_req_failed")
    failed_requests = round(error_rate * total_requests)

    return MetricsSummary(
        p50_ms=p50_ms,
        p95_ms=p95_ms,
        p99_ms=p99_ms,
        average_ms=average_ms,
        max_ms=max_ms,
        rps=rps,
        total_requests=total_requests,
        failed_requests=failed_requests,
        error_rate=error_rate,
        duration_s=duration_s,
    )
