"""TEMPORARY reference implementation of PerformanceEngine.

This exists ONLY to prove the Phase-1 golden path end to end (real k6
subprocess, real output, real metrics) while Developer 2's actual
performance engine (proper Jinja2 script templates, schema-aware payload
generation) does not exist yet.

Do not extend this module with real product features. When Developer 2's
engine lands, this file should be deleted and whatever wires an engine
into the API layer should point at theirs instead -- `PerformanceEngine`
is the only contract that matters, not this class.

Known simplifications vs. the real engine (documented, not silent):
  - Issues a bare GET to each selected endpoint; no schema-aware payload
    generation.
  - No auth support.

Uses k6's --summary-export as the result artifact -- this is the frozen
MVP contract (see performance_engine_interface.md), not a simplification.
Raw NDJSON / steady-state windowing is explicitly out of scope for MVP:
boundary search runs one k6 invocation per experiment (one VU level, one
summary), so there is no multi-stage ladder inside a single run that would
need windowing.
"""

import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import K6_BINARY, K6_EXECUTION_TIMEOUT_S
from app.schemas.enums import ObjectiveType, ResultClassification
from app.schemas.test_plan import TargetConfig, TestPlan
from app.schemas.test_result import EngineExecutionOutcome, MetricsSummary

# Frozen MVP canonical result artifact command line -- see
# docs/performance_engine_interface.md. Dev-2's real engine must invoke k6
# the same way (same trend stats, --summary-export) for the same reason:
# these are exactly the fields MetricsSummary needs, nothing more.
_SUMMARY_TREND_STATS = "min,med,avg,max,p(50),p(95),p(99)"


def _render_script(plan: TestPlan, target: TargetConfig) -> str:
    endpoints_json = json.dumps(plan.selected_endpoints)

    if plan.objective_type == ObjectiveType.boundary_search:
        stages = (
            f"{{ duration: '{plan.ramp_duration}', target: {plan.target_vus} }},\n"
            f"    {{ duration: '{plan.hold_duration}', target: {plan.target_vus} }},"
        )
    else:  # fixed_load
        stages = f"{{ duration: '{plan.duration}', target: {plan.target_vus} }},"

    return f"""\
import http from 'k6/http';
import {{ sleep }} from 'k6';

export const options = {{
  scenarios: {{
    reference_stub: {{
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
    {stages}
      ],
      gracefulRampDown: '0s',
    }},
  }},
}};

const BASE_URL = '{target.base_url}';
const ENDPOINTS = {endpoints_json};

export default function () {{
  const path = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
  http.get(`${{BASE_URL}}${{path}}`);
  sleep(1);
}}
"""


def _evaluate_threshold(metrics: MetricsSummary, plan: TestPlan) -> ResultClassification:
    ok = (
        metrics.p95_ms <= plan.thresholds.p95_latency_ms
        and metrics.error_rate <= plan.thresholds.error_rate
    )
    return ResultClassification.PASS if ok else ResultClassification.FAIL


def _metric_stats(metrics: dict, name: str) -> dict:
    """k6's --summary-export layout has varied across versions: some put a
    metric's stats directly on the metric object, others nest them under a
    'values' key. Handle both defensively rather than pinning to one."""

    entry = metrics.get(name, {})
    values = entry.get("values")
    return values if isinstance(values, dict) else entry


def _parse_summary(summary_path: Path, duration_s: float) -> MetricsSummary:
    data = json.loads(summary_path.read_text())
    metrics = data.get("metrics", {})

    duration_stats = _metric_stats(metrics, "http_req_duration")
    reqs_stats = _metric_stats(metrics, "http_reqs")
    failed_stats = _metric_stats(metrics, "http_req_failed")

    total_requests = int(reqs_stats.get("count", 0))
    # http_req_failed is a k6 "rate" metric: its aggregate value (fraction
    # of requests marked failed) is exposed as "value" in the flat summary
    # layout, or "rate" in the values-wrapped layout.
    error_rate = float(failed_stats.get("value", failed_stats.get("rate", 0.0)))

    return MetricsSummary(
        p50_ms=float(duration_stats.get("p(50)", duration_stats.get("med", 0.0))),
        p95_ms=float(duration_stats.get("p(95)", 0.0)),
        p99_ms=float(duration_stats.get("p(99)", 0.0)),
        average_ms=float(duration_stats.get("avg", 0.0)),
        max_ms=float(duration_stats.get("max", 0.0)),
        rps=float(reqs_stats.get("rate", 0.0)),
        total_requests=total_requests,
        failed_requests=round(error_rate * total_requests),
        error_rate=error_rate,
        duration_s=duration_s,
    )


class ReferenceK6Engine:
    """Minimal but real PerformanceEngine implementation. See module
    docstring: temporary, to be replaced by Developer 2's engine."""

    def execute(
        self,
        plan: TestPlan,
        target: TargetConfig,
        artifact_directory: Path,
    ) -> EngineExecutionOutcome:
        artifact_directory.mkdir(parents=True, exist_ok=True)
        script_path = artifact_directory / "script.js"
        summary_path = artifact_directory / "summary.json"
        stdout_path = artifact_directory / "stdout.log"
        stderr_path = artifact_directory / "stderr.log"

        script_path.write_text(_render_script(plan, target))

        cmd = [
            K6_BINARY,
            "run",
            "--quiet",
            "--summary-trend-stats",
            _SUMMARY_TREND_STATS,
            "--summary-export",
            str(summary_path),
            str(script_path),
        ]

        started_at = datetime.now(timezone.utc)
        wall_start = time.monotonic()
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(artifact_directory),
                capture_output=True,
                text=True,
                timeout=K6_EXECUTION_TIMEOUT_S,
                shell=False,
            )
            exit_code = proc.returncode
            stdout, stderr = proc.stdout, proc.stderr
            error_message = None
        except subprocess.TimeoutExpired as exc:
            exit_code = -1
            stdout = exc.stdout or ""
            stderr = (exc.stderr or "") + f"\n[execution timed out after {K6_EXECUTION_TIMEOUT_S}s]"
            error_message = f"k6 execution timed out after {K6_EXECUTION_TIMEOUT_S}s"
        except FileNotFoundError as exc:
            exit_code = -1
            stdout, stderr = "", ""
            error_message = f"k6 binary not found ('{K6_BINARY}'): {exc}"

        finished_at = datetime.now(timezone.utc)
        duration_s = time.monotonic() - wall_start

        stdout_path.write_text(stdout)
        stderr_path.write_text(stderr)

        summary_exists = summary_path.exists()
        metrics = None
        threshold_status = None
        if summary_exists:
            try:
                metrics = _parse_summary(summary_path, duration_s)
                threshold_status = _evaluate_threshold(metrics, plan)
            except (json.JSONDecodeError, KeyError, ValueError) as exc:
                summary_exists = False
                error_message = f"failed to parse k6 summary: {exc}"

        return EngineExecutionOutcome(
            exit_code=exit_code,
            summary_exists=summary_exists,
            metrics=metrics,
            threshold_status=threshold_status,
            raw_output_path=None,
            summary_path=str(summary_path) if summary_exists else None,
            stdout_log_path=str(stdout_path),
            stderr_log_path=str(stderr_path),
            started_at=started_at,
            finished_at=finished_at,
            error_message=None if summary_exists else error_message,
        )
