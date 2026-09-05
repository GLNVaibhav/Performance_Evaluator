"""RealK6PerformanceEngine: implements app.services.performance_engine.PerformanceEngine.

This is the ONLY class the backend ever touches (via engine_provider.py).
Everything else in this package is a private implementation detail.

execute() never raises for a legitimate performance failure -- that is
expressed as EngineExecutionOutcome(summary_exists=True, threshold_status=FAIL).
It raises (or returns summary_exists=False) only for genuine execution
failure: unreachable target/spec, unresolvable endpoint, unsupported
payload schema, k6 not found, subprocess crash, timeout, or an unusable
results.json. See performance_engine_interface.md.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import K6_BINARY, K6_EXECUTION_TIMEOUT_S
from app.schemas.test_plan import TargetConfig, TestPlan
from app.schemas.test_result import EngineExecutionOutcome
from app.services.k6_engine.endpoint_resolver import ResolutionError
from app.services.k6_engine.k6_runner import run_k6
from app.services.k6_engine.metrics_parser import MetricsParseError, parse_results
from app.services.k6_engine.openapi_loader import OpenAPILoadError, load_normalized
from app.services.k6_engine.payload_generator import UnsupportedSchemaError
from app.services.k6_engine.script_renderer import build_endpoint_tags, render_script
from app.services.k6_engine.threshold_evaluator import evaluate_threshold, localize_failures

# Every failure mode above this line that means "the plan could not even
# be turned into a runnable script" collapses to one execution-failure
# outcome -- the caller (run_service) doesn't need to distinguish *why*
# script preparation failed, only that it did, before any k6 process ran.
_PRE_EXECUTION_ERRORS = (OpenAPILoadError, ResolutionError, UnsupportedSchemaError)


class RealK6PerformanceEngine:
    def execute(
        self,
        plan: TestPlan,
        target: TargetConfig,
        artifact_directory: Path,
    ) -> EngineExecutionOutcome:
        started_at = datetime.now(timezone.utc)
        artifact_directory.mkdir(parents=True, exist_ok=True)

        try:
            spec = load_normalized(target.base_url)
            script = render_script(plan, target, spec)
            endpoint_tags = build_endpoint_tags(plan, spec)
        except _PRE_EXECUTION_ERRORS as exc:
            finished_at = datetime.now(timezone.utc)
            return EngineExecutionOutcome(
                exit_code=-1,
                summary_exists=False,
                stdout_log_path=None,
                stderr_log_path=None,
                started_at=started_at,
                finished_at=finished_at,
                error_message=f"could not prepare k6 script: {exc}",
            )

        script_path = artifact_directory / "script.js"
        script_path.write_text(script)

        wall_start = time.monotonic()
        outcome = run_k6(
            script_path=script_path,
            artifact_directory=artifact_directory,
            k6_binary=K6_BINARY,
            timeout_s=K6_EXECUTION_TIMEOUT_S,
        )
        duration_s = time.monotonic() - wall_start

        # BLOCKER 2 fix: exit_code != 0 is an execution failure regardless
        # of whether results.json exists. A present results.json does not
        # override a failed process -- see performance_engine_interface.md
        # and the frozen order of authority in the remediation brief:
        # timeout / non-zero exit / missing results / malformed results
        # ALL precede "parse metrics and evaluate thresholds".
        if outcome.exit_code != 0 or not outcome.results_exists:
            return EngineExecutionOutcome(
                exit_code=outcome.exit_code,
                summary_exists=False,
                stdout_log_path=str(outcome.stdout_path),
                stderr_log_path=str(outcome.stderr_path),
                started_at=outcome.started_at,
                finished_at=outcome.finished_at,
                error_message=outcome.error_message
                or f"k6 exited with non-zero status {outcome.exit_code}",
            )

        try:
            metrics = parse_results(outcome.results_path, duration_s, endpoint_tags)
        except MetricsParseError as exc:
            return EngineExecutionOutcome(
                exit_code=outcome.exit_code,
                summary_exists=False,
                stdout_log_path=str(outcome.stdout_path),
                stderr_log_path=str(outcome.stderr_path),
                started_at=outcome.started_at,
                finished_at=outcome.finished_at,
                error_message=str(exc),
            )

        threshold_status = evaluate_threshold(metrics, plan)
        threshold_violations = localize_failures(metrics, plan)

        return EngineExecutionOutcome(
            exit_code=outcome.exit_code,
            summary_exists=True,
            metrics=metrics,
            threshold_status=threshold_status,
            threshold_violations=threshold_violations,
            raw_output_path=None,  # NDJSON not part of the MVP contract (section 4)
            summary_path=str(outcome.results_path),
            stdout_log_path=str(outcome.stdout_path),
            stderr_log_path=str(outcome.stderr_path),
            started_at=outcome.started_at,
            finished_at=outcome.finished_at,
            error_message=None,
        )
