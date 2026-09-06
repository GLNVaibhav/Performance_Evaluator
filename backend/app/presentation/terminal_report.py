"""Terminal presentation layer (Session 6). Pure formatting only.

Reads already-computed, already-persisted structured data --
`app.schemas.test_plan.TestPlan`, `app.schemas.test_result.TestResult`/
`Statistics` (Session 5), `app.schemas.enums.RunState` -- and returns
human-readable strings. This module NEVER:

  - recomputes a percentile, rate, or ranking (every number here is read
    straight off an already-built `Statistics`/`MetricsSummary` object --
    see app/schemas/test_result.py::build_statistics() for where that
    arithmetic actually happens, once),
  - parses a k6 results.json a second time,
  - invents or hardcodes a status code (renders whatever
    `Statistics.status_codes.counts` actually contains, however many keys
    that is),
  - infers a cause or calls an LLM,
  - touches `TargetConfig.auth` or any credential -- structurally
    impossible anyway, since neither `TestResult` nor `RunStatusResponse`
    has an auth-shaped field at all (see docs/target_auth_contract.md).

Two units need care, and both are handled once, here, consistently:

  - `error_rate`/`success_rate` (Statistics.errors) are FRACTIONS (0..1,
    same convention as MetricsSummary) -> multiplied by 100 for display.
  - `Statistics.status_codes.percentages` values are ALREADY on a 0..100
    scale (computed that way in build_statistics()) -> displayed AS-IS,
    never multiplied again. Mixing these two up (Part C's exact warning)
    is the one bug this module's tests are most focused on catching.
"""
from __future__ import annotations

from typing import List, Optional

from app.schemas.enums import ObjectiveType, ResultClassification, RunState
from app.schemas.test_plan import TestPlan
from app.schemas.test_result import (
    EndpointMetrics,
    Statistics,
    TestResult,
    ThresholdViolation,
)

_WIDTH = 50
_RULE = "=" * _WIDTH


def _rule_section(title: str) -> str:
    return f"{_RULE}\n{title}\n{_RULE}"


def _fmt_ms(value: Optional[float]) -> str:
    """N/A for a percentile this run genuinely didn't collect (e.g. p75/p90
    on a results.json predating that mechanism) -- never a guessed number."""
    return "N/A" if value is None else f"{value:.2f} ms"


def _fmt_fraction_pct(value: float) -> str:
    """For fields whose canonical representation is a 0..1 fraction
    (error_rate, success_rate, endpoint traffic/failure shares)."""
    return f"{value * 100:.2f}%"


def _fmt_already_pct(value: float) -> str:
    """For fields ALREADY expressed on a 0..100 scale
    (Statistics.status_codes.percentages) -- do not multiply again."""
    return f"{value:.1f}%"


def _fmt_ratio(value: Optional[float]) -> str:
    return "N/A" if value is None else f"{value:.2f}x"


def _fmt_count(value: int) -> str:
    return f"{value:,}"


# --- Header: target / test / workload / status ------------------------------


def render_header(
    target_base_url: Optional[str],
    plan: Optional[TestPlan],
    state: RunState,
    error_message: Optional[str] = None,
) -> str:
    """The top block -- always renderable, even before a result exists
    (QUEUED/RUNNING), from data the caller already has in hand (the plan
    it submitted, the target it's polling, and the run's current state --
    see app/schemas/run.py::RunStatusResponse, unchanged by this session)."""
    lines = [_rule_section("PERFORMANCE TEST"), ""]

    lines.append("Target:")
    lines.append(f"  {target_base_url or 'N/A'}")
    lines.append("")

    lines.append("Test:")
    lines.append(f"  {plan.test_type.value if plan is not None else 'N/A'}")
    lines.append("")

    lines.append("Workload:")
    if plan is None:
        lines.append("  N/A")
    else:
        lines.append(f"  VUs: {plan.target_vus}")
        if plan.objective_type == ObjectiveType.boundary_search:
            lines.append(f"  Ramp: {plan.ramp_duration}")
            lines.append(f"  Hold: {plan.hold_duration}")
        else:
            lines.append(f"  Duration: {plan.duration}")
        lines.append(f"  Endpoints: {', '.join(plan.selected_endpoints)}")
        if plan.endpoint_weights:
            mix = ", ".join(f"{ep}={weight}" for ep, weight in plan.endpoint_weights.items())
            lines.append(f"  Endpoint weights: {mix}")
    lines.append("")

    lines.append("Status:")
    lines.append(f"  {state.value}")
    if state == RunState.EXECUTION_ERROR:
        lines.append("")
        lines.append("Execution error:")
        # Never a raw stack trace by default -- the concise, already-stored
        # error_message (run_service.py's mark_run_execution_error), same
        # string GET /runs/{id} already returns. Full detail remains in
        # the project's existing logs, unmodified by this session.
        lines.append(f"  {error_message or '(no error message recorded)'}")

    return "\n".join(lines)


# --- Results sections ---------------------------------------------------------


def _render_latency(stats: Statistics) -> str:
    lat = stats.latency
    lines = [
        "Latency",
        f"  p50:  {_fmt_ms(lat.p50_ms)}",
        f"  p75:  {_fmt_ms(lat.p75_ms)}",
        f"  p90:  {_fmt_ms(lat.p90_ms)}",
        f"  p95:  {_fmt_ms(lat.p95_ms)}",
        f"  p99:  {_fmt_ms(lat.p99_ms)}",
        f"  avg:  {_fmt_ms(lat.average_ms)}",
        f"  max:  {_fmt_ms(lat.max_ms)}",
    ]
    if lat.tail_latency_ratio is not None:
        lines.append(f"  p99/p50 ratio: {_fmt_ratio(lat.tail_latency_ratio)}")
    return "\n".join(lines)


def _render_throughput(stats: Statistics) -> str:
    tp = stats.throughput
    return "\n".join(
        [
            "Throughput",
            f"  requests:   {_fmt_count(tp.total_requests)}",
            f"  req/s:      {tp.requests_per_second:.2f}",
            f"  req/min:    {tp.requests_per_minute:.2f}",
        ]
    )


def _render_errors(stats: Statistics) -> str:
    err = stats.errors
    return "\n".join(
        [
            "Errors",
            f"  failed:       {_fmt_count(err.failed_requests)}",
            f"  error rate:   {_fmt_fraction_pct(err.error_rate)}",
            f"  success rate: {_fmt_fraction_pct(err.success_rate)}",
        ]
    )


def _render_status_codes(stats: Statistics) -> str:
    counts = stats.status_codes.counts
    if not counts:
        return "HTTP Status Codes\n  No status-code evidence available"
    lines = ["HTTP Status Codes"]
    # Deterministic, stable order: numeric ascending by status code --
    # never a hardcoded/assumed list, purely a display-order choice over
    # whatever codes were actually observed.
    for code in sorted(counts, key=lambda c: (len(c), c)):
        count = counts[code]
        pct = stats.status_codes.percentages.get(code)
        pct_str = f" ({_fmt_already_pct(pct)})" if pct is not None else ""
        lines.append(f"  {code}: {_fmt_count(count)}{pct_str}")
    return "\n".join(lines)


def _render_endpoint_table(stats: Statistics, per_endpoint: List[EndpointMetrics]) -> str:
    ranking = stats.endpoint_rankings.highest_p95_latency
    if not ranking or not per_endpoint:
        return "Endpoint Performance\n  No endpoint evidence available"

    by_key = {(e.endpoint, e.method): e for e in per_endpoint}
    lines = ["Endpoint Performance", f"  {'endpoint':<30} {'requests':>10} {'p95':>10} {'error rate':>12}"]
    for entry in ranking:  # order = the SAME canonical ranking Session 5 already computed
        detail = by_key.get((entry.endpoint, entry.method))
        if detail is None:
            continue
        lines.append(
            f"  {detail.endpoint:<30} {_fmt_count(detail.total_requests):>10} "
            f"{_fmt_ms(detail.p95_ms):>10} {_fmt_fraction_pct(detail.error_rate):>12}"
        )
    return "\n".join(lines)


def _render_threshold(threshold_status: ResultClassification, violations: List[ThresholdViolation]) -> str:
    lines = [f"Threshold Status: {threshold_status.value}"]
    if threshold_status == ResultClassification.FAIL and violations:
        lines.append("")
        lines.append("Violations:")
        for v in violations:
            # threshold_evaluator.py's localize_failures() only ever emits
            # `metric` as the literal string "p95_latency_ms" or
            # "error_rate" (see that module) -- this substring check is
            # coupled to those two exact names, not a general unit-sniffer.
            if "rate" in v.metric:
                observed = _fmt_fraction_pct(v.observed)
                threshold = _fmt_fraction_pct(v.threshold)
            else:
                observed = _fmt_ms(v.observed)
                threshold = _fmt_ms(v.threshold)
            lines.append(f"  {v.scope} {v.metric} {observed} > {threshold}")
    return "\n".join(lines)


def _render_artifacts(result: TestResult) -> str:
    if result.artifacts is None:
        return "Artifacts:\n  N/A"
    fields = [
        ("script", result.artifacts.script_path),
        ("results", result.artifacts.results_json_path),
        ("stdout", result.artifacts.stdout_log_path),
        ("stderr", result.artifacts.stderr_log_path),
    ]
    present = [(name, path) for name, path in fields if path]
    if not present:
        return "Artifacts:\n  N/A"
    lines = ["Artifacts:"]
    for name, path in present:
        lines.append(f"  {name}: {path}")
    return "\n".join(lines)


def render_results(result: TestResult) -> str:
    """The full RESULTS block -- only ever called for a COMPLETED run
    (a TestResult only exists at all for that state; see
    app/api/routes_runs.py::get_run_result()'s state handling, unchanged
    by this session). `result.statistics` is always populated by that
    route (build_statistics() runs unconditionally) -- but this function
    still degrades safely (falls back to the raw metrics/aggregate status)
    if a caller ever hands it an older TestResult with `statistics=None`,
    e.g. one hand-constructed in a test."""
    stats = result.statistics
    if stats is None:
        return "\n".join(
            [
                _rule_section("RESULTS"),
                "",
                "(no structured statistics available for this result)",
                "",
                _render_threshold(result.threshold_status, result.threshold_violations),
                "",
                _render_artifacts(result),
            ]
        )

    return "\n".join(
        [
            _rule_section("RESULTS"),
            "",
            _render_latency(stats),
            "",
            _render_throughput(stats),
            "",
            _render_errors(stats),
            "",
            _render_status_codes(stats),
            "",
            _render_endpoint_table(stats, result.metrics.per_endpoint),
            "",
            _render_threshold(result.threshold_status, result.threshold_violations),
            "",
            _render_artifacts(result),
        ]
    )


def render_completed_report(result: TestResult) -> str:
    """Full report for a COMPLETED run: header + results, in one string --
    the single call a demo script makes once polling reaches COMPLETED."""
    header = render_header(
        target_base_url=result.target_base_url,
        plan=result.plan,
        state=RunState.COMPLETED,
    )
    return header + "\n\n" + render_results(result)
