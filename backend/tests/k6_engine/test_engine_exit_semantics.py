"""BLOCKER 2 regression tests (Dev-3 gate review): a non-zero k6 process
exit code must ALWAYS produce an execution-failure outcome
(summary_exists=False), even when results.json exists on disk. The
presence of a results artifact must never override process failure.

Primary tests mock k6_runner.run_k6 directly against engine.py, which is
deterministic and doesn't depend on finding a real k6 invocation that
happens to exit non-zero while still producing output. A second,
real-subprocess test at the bottom proves the same invariant end-to-end
with an actual failing k6 process (skipped if k6 isn't available).
"""
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest

from app.schemas.enums import ResultClassification
from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.engine import RealK6PerformanceEngine
from app.services.k6_engine.k6_runner import K6RunOutcome
from app.services.k6_engine.openapi_loader import normalize

_SPEC = normalize({"paths": {"/products": {"get": {}}}})
_TARGET = TargetConfig(base_url="http://127.0.0.1:8080")
_PLAN = FixedLoadPlan(
    test_type="baseline",
    thresholds=Thresholds(p95_latency_ms=2000, error_rate=0.05),
    selected_endpoints=["/products"],
    target_vus=10,
    duration="10s",
)


def _fake_outcome(exit_code: int, results_exists: bool, results_path: Path) -> K6RunOutcome:
    from datetime import datetime, timezone

    return K6RunOutcome(
        exit_code=exit_code,
        results_path=results_path,
        results_exists=results_exists,
        stdout_path=results_path.parent / "stdout.log",
        stderr_path=results_path.parent / "stderr.log",
        started_at=datetime.now(timezone.utc),
        finished_at=datetime.now(timezone.utc),
        error_message=None if exit_code == 0 else f"k6 exited with non-zero status {exit_code}",
    )


def test_nonzero_exit_with_existing_results_json_is_execution_failure(tmp_path):
    """The exact scenario Dev-3 found: k6 exits non-zero but results.json
    is present and well-formed. Must be EXECUTION_ERROR, never COMPLETED,
    regardless of what the (unread) results.json contains."""
    results_path = tmp_path / "results.json"
    real_pass_fixture = Path(__file__).parent / "fixtures" / "real_pass_results.json"
    results_path.write_text(real_pass_fixture.read_text())

    fake_outcome = _fake_outcome(exit_code=7, results_exists=True, results_path=results_path)

    with patch("app.services.k6_engine.engine.load_normalized", return_value=_SPEC), \
         patch("app.services.k6_engine.engine.run_k6", return_value=fake_outcome):
        engine = RealK6PerformanceEngine()
        outcome = engine.execute(_PLAN, _TARGET, tmp_path)

    assert outcome.summary_exists is False, (
        "non-zero exit_code with a present results.json must NOT be treated "
        "as a successful engine outcome"
    )
    assert outcome.metrics is None
    assert outcome.threshold_status is None
    assert outcome.exit_code == 7
    assert outcome.error_message is not None


@pytest.mark.parametrize("exit_code", [1, 2, 99, -1, -9])
def test_various_nonzero_exit_codes_all_produce_execution_failure(tmp_path, exit_code):
    results_path = tmp_path / "results.json"
    real_pass_fixture = Path(__file__).parent / "fixtures" / "real_pass_results.json"
    results_path.write_text(real_pass_fixture.read_text())

    fake_outcome = _fake_outcome(exit_code=exit_code, results_exists=True, results_path=results_path)

    with patch("app.services.k6_engine.engine.load_normalized", return_value=_SPEC), \
         patch("app.services.k6_engine.engine.run_k6", return_value=fake_outcome):
        engine = RealK6PerformanceEngine()
        outcome = engine.execute(_PLAN, _TARGET, tmp_path)

    assert outcome.summary_exists is False, f"exit_code={exit_code} must be an execution failure"
    assert outcome.metrics is None
    assert outcome.threshold_status is None


def test_zero_exit_with_threshold_violation_is_completed_fail_not_execution_error(tmp_path):
    """The opposite, equally load-bearing invariant: a healthy process
    (exit_code == 0) with a usable results.json showing a genuine
    threshold violation must be a normal performance FAIL, not an
    execution error."""
    results_path = tmp_path / "results.json"
    real_fail_fixture = Path(__file__).parent / "fixtures" / "real_fail_results.json"
    results_path.write_text(real_fail_fixture.read_text())

    fake_outcome = _fake_outcome(exit_code=0, results_exists=True, results_path=results_path)

    strict_plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=2000, error_rate=0.01),  # real fixture has ~30% errors
        selected_endpoints=["/products"],
        target_vus=10,
        duration="10s",
    )

    with patch("app.services.k6_engine.engine.load_normalized", return_value=_SPEC), \
         patch("app.services.k6_engine.engine.run_k6", return_value=fake_outcome):
        engine = RealK6PerformanceEngine()
        outcome = engine.execute(strict_plan, _TARGET, tmp_path)

    assert outcome.summary_exists is True
    assert outcome.metrics is not None
    assert outcome.threshold_status == ResultClassification.FAIL
    assert outcome.exit_code == 0
    assert outcome.error_message is None


def test_zero_exit_with_healthy_metrics_is_completed_pass(tmp_path):
    results_path = tmp_path / "results.json"
    real_pass_fixture = Path(__file__).parent / "fixtures" / "real_pass_results.json"
    results_path.write_text(real_pass_fixture.read_text())

    fake_outcome = _fake_outcome(exit_code=0, results_exists=True, results_path=results_path)

    with patch("app.services.k6_engine.engine.load_normalized", return_value=_SPEC), \
         patch("app.services.k6_engine.engine.run_k6", return_value=fake_outcome):
        engine = RealK6PerformanceEngine()
        outcome = engine.execute(_PLAN, _TARGET, tmp_path)

    assert outcome.summary_exists is True
    assert outcome.threshold_status == ResultClassification.PASS
    assert outcome.exit_code == 0


def test_missing_results_json_with_zero_exit_is_still_execution_failure(tmp_path):
    """Sanity: the pre-existing 'missing results.json' path must survive
    unchanged alongside the new non-zero-exit check."""
    results_path = tmp_path / "results.json"  # never written

    fake_outcome = _fake_outcome(exit_code=0, results_exists=False, results_path=results_path)

    with patch("app.services.k6_engine.engine.load_normalized", return_value=_SPEC), \
         patch("app.services.k6_engine.engine.run_k6", return_value=fake_outcome):
        engine = RealK6PerformanceEngine()
        outcome = engine.execute(_PLAN, _TARGET, tmp_path)

    assert outcome.summary_exists is False
    assert outcome.metrics is None


# --- Real subprocess proof, not mocked -------------------------------------

_K6_BINARY = "/home/claude/k6-v2.2.0-linux-amd64/k6"


@pytest.mark.skipif(
    not (shutil.which(_K6_BINARY) or Path(_K6_BINARY).exists()),
    reason="real k6 binary not available for end-to-end non-zero-exit proof",
)
def test_real_k6_process_with_native_threshold_failure_is_execution_error(tmp_path):
    """Craft a script with a k6-NATIVE threshold that WILL be crossed
    (unlike script_renderer's own templates, which declare no k6-native
    thresholds and rely entirely on our own deterministic evaluator).
    A crossed native k6 threshold makes the k6 PROCESS ITSELF exit
    non-zero while still writing a complete, well-formed results.json --
    exactly the scenario Dev-3's review found unhandled. Runs through
    k6_runner.run_k6() and RealK6PerformanceEngine.execute() for real,
    no mocks, to prove the fix holds against actual k6 behavior."""
    from app.services.k6_engine.k6_runner import run_k6

    # A tiny throwaway HTTP server that always responds instantly and
    # successfully -- the failure must come from the NATIVE k6 threshold
    # below (iterations < 1000, guaranteed false for one quick iteration),
    # not from any real application behavior.
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), _Handler)
    port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        script = (
            "import http from 'k6/http';\n"
            "export const options = {\n"
            "  vus: 1,\n"
            "  iterations: 1,\n"
            "  thresholds: {\n"
            "    iterations: ['count>=1000'],\n"
            "  },\n"
            "};\n"
            "export default function () {\n"
            f"  http.get('http://127.0.0.1:{port}/');\n"
            "}\n"
        )
        script_path = tmp_path / "script.js"
        script_path.write_text(script)

        outcome = run_k6(
            script_path=script_path,
            artifact_directory=tmp_path,
            k6_binary=_K6_BINARY,
            timeout_s=30,
        )

        assert outcome.exit_code != 0, "expected the native k6 threshold to fail the process"
        assert outcome.results_exists is True, "expected k6 to still write results.json despite the failed threshold"

        engine = RealK6PerformanceEngine()

        with patch("app.services.k6_engine.engine.run_k6", return_value=outcome), \
             patch("app.services.k6_engine.engine.load_normalized", return_value=_SPEC):
            final_outcome = engine.execute(_PLAN, TargetConfig(base_url=f"http://127.0.0.1:{port}"), tmp_path)

        assert final_outcome.summary_exists is False, (
            "REAL non-zero k6 exit with a REAL existing results.json must still be an execution failure"
        )
        assert final_outcome.metrics is None
        assert final_outcome.threshold_status is None
    finally:
        server.shutdown()
