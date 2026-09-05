"""k6 results.json -> MetricsSummary. No percentile math here -- k6 already
computed everything; this module only extracts and relabels (section 5).

Handles both known --summary-export layouts defensively (flat stats
directly on the metric object, vs. nested under a 'values' key) since the
layout has varied across k6 versions -- see performance_engine_interface.md.

Missing required metrics is an execution failure, not a metric silently
returned as zero (section 15, section 5).

--- Per-endpoint breakdown (additive amendment) --------------------------

`endpoint_tags` (optional, from script_renderer.build_endpoint_tags()) maps
each selected endpoint to the k6 tag alias script_renderer used for it
(`endpoint_0`, `endpoint_1`, ...). When given, this module also looks up
the tagged submetrics k6 computes because script_renderer emitted
tautological per-alias threshold expressions (verified empirically against
the pinned k6 v2.2.0 binary -- see performance_engine_interface.md).

Per-endpoint parsing is intentionally lenient where aggregate parsing is
strict: an endpoint with no requests recorded (e.g. a very short run
combined with a very small configured weight) is silently OMITTED from
`per_endpoint` rather than raising -- real evidence for that endpoint
simply doesn't exist in this run, so it isn't fabricated, but that must
never fail the whole run when the aggregate result is otherwise fine (the
existing execution-failure-vs-performance-failure distinction is about the
AGGREGATE result and is completely unaffected by per-endpoint enrichment).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional

from app.schemas.test_result import EndpointMetrics, MetricsSummary
from app.services.k6_engine.script_renderer import EndpointTagInfo


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


def _optional_stat(stats: dict, *keys: str):
    for key in keys:
        if key in stats:
            return stats[key]
    return None


def _parse_one_endpoint(metrics: dict, duration_s: float, tag: EndpointTagInfo) -> Optional[EndpointMetrics]:
    """Returns None (never raises) if this endpoint has no usable evidence
    in this run's results.json -- see module docstring."""
    selector = f"{{endpoint:{tag.alias}}}"
    duration_stats = _metric_stats(metrics, f"http_req_duration{selector}")
    reqs_stats = _metric_stats(metrics, f"http_reqs{selector}")
    failed_stats = _metric_stats(metrics, f"http_req_failed{selector}")

    total_requests = _optional_stat(reqs_stats, "count")
    if not total_requests:
        return None
    total_requests = int(total_requests)

    p50 = _optional_stat(duration_stats, "p(50)", "med")
    p95 = _optional_stat(duration_stats, "p(95)")
    p99 = _optional_stat(duration_stats, "p(99)")
    average = _optional_stat(duration_stats, "avg")
    maximum = _optional_stat(duration_stats, "max")
    if None in (p50, p95, p99, average, maximum):
        return None

    rps = _optional_stat(reqs_stats, "rate")
    if rps is None:
        rps = total_requests / duration_s if duration_s > 0 else 0.0

    error_rate = _optional_stat(failed_stats, "value", "rate")
    if error_rate is None:
        error_rate = 0.0
    error_rate = min(max(float(error_rate), 0.0), 1.0)

    # k6's Rate-metric JSON export names these from the rate CONDITION's
    # point of view, not from an HTTP-success point of view: "passes" is
    # the count of samples where http_req_failed was true (the request
    # actually failed); "fails" is the count where it was false (the
    # request succeeded). Verified empirically against a real k6 v2.2.0
    # run with zero real failures, where {"passes": 0, "fails": <total
    # requests>, "value": 0} was observed -- "fails" equaling the full
    # request count only makes sense under this reading. Using "fails"
    # here would report every successful request as a failure.
    passes = _optional_stat(failed_stats, "passes")
    failed_requests = int(passes) if passes is not None else round(error_rate * total_requests)

    return EndpointMetrics(
        endpoint=tag.endpoint,
        method=tag.method,
        total_requests=total_requests,
        p50_ms=float(p50),
        p95_ms=float(p95),
        p99_ms=float(p99),
        average_ms=float(average),
        max_ms=float(maximum),
        rps=float(rps),
        failed_requests=failed_requests,
        error_rate=error_rate,
    )


def _parse_per_endpoint(
    metrics: dict, duration_s: float, endpoint_tags: Optional[List[EndpointTagInfo]]
) -> List[EndpointMetrics]:
    per_endpoint: List[EndpointMetrics] = []
    for tag in endpoint_tags or []:
        try:
            entry = _parse_one_endpoint(metrics, duration_s, tag)
        except Exception:
            # Best-effort enrichment: a malformed per-tag entry must never
            # fail the whole (otherwise valid) run -- see module docstring.
            entry = None
        if entry is not None:
            per_endpoint.append(entry)
    return per_endpoint


def parse_results(
    results_path: Path,
    duration_s: float,
    endpoint_tags: Optional[List[EndpointTagInfo]] = None,
) -> MetricsSummary:
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
        per_endpoint=_parse_per_endpoint(metrics, duration_s, endpoint_tags),
    )
