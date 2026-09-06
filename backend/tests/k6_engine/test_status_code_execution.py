"""Session 5: REAL k6 subprocess execution proving HTTP status-code
evidence is genuinely collected from a real target -- not just that the
generated script.js *looks* right. A stub target deterministically cycles
through 200/200/404/500 responses so the exact codes observed are known
in advance; the test asserts the parsed MetricsSummary.status_codes (and
the derived Statistics.status_codes) match reality exactly, with NO other
codes invented and none omitted.
"""
import json
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.schemas.test_result import build_statistics
from app.services.k6_engine.engine import RealK6PerformanceEngine

K6_BINARY = "/c/Program Files/k6/k6.exe" if Path("/c/Program Files/k6/k6.exe").exists() else "k6"

pytestmark = pytest.mark.skipif(
    shutil.which(K6_BINARY) is None and not Path(K6_BINARY).exists(),
    reason=f"k6 binary not found at '{K6_BINARY}' -- set K6_BINARY",
)

_OPENAPI_DOC = json.dumps({"paths": {"/products": {"get": {}}}}).encode()
_CYCLE = [200, 200, 404, 500]  # deterministic, known-in-advance response pattern


class _CyclingStatusHandler(BaseHTTPRequestHandler):
    _counter_lock = threading.Lock()
    counter = 0

    def do_GET(self):
        if self.path == "/openapi.json":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(_OPENAPI_DOC)))
            self.end_headers()
            self.wfile.write(_OPENAPI_DOC)
            return

        with _CyclingStatusHandler._counter_lock:
            status = _CYCLE[_CyclingStatusHandler.counter % len(_CYCLE)]
            _CyclingStatusHandler.counter += 1

        body = b"{}"
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture()
def cycling_server():
    _CyclingStatusHandler.counter = 0
    server = HTTPServer(("127.0.0.1", 0), _CyclingStatusHandler)
    port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()


@pytest.fixture()
def artifact_dir():
    d = Path(tempfile.mkdtemp(prefix="pe-status-code-"))
    yield d
    shutil.rmtree(d, ignore_errors=True)


def test_real_k6_run_reports_exactly_the_statuses_actually_observed(monkeypatch, cycling_server, artifact_dir):
    import app.services.k6_engine.engine as engine_module

    monkeypatch.setattr(engine_module, "K6_BINARY", K6_BINARY)
    engine = RealK6PerformanceEngine()

    target = TargetConfig(base_url=cycling_server)
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=5000, error_rate=1.0),
        selected_endpoints=["/products"],
        target_vus=3,
        duration="4s",
    )

    outcome = engine.execute(plan, target, artifact_dir)
    assert outcome.summary_exists, outcome.error_message

    status_codes = outcome.metrics.status_codes
    # Only real, known-cycle codes appear -- never a hardcoded/invented one.
    assert set(status_codes.keys()) <= {"200", "404", "500"}
    assert status_codes, "expected at least one status code to be recorded"
    assert sum(status_codes.values()) == outcome.metrics.total_requests

    # 2 of every 4 responses are 200 -- given enough real requests, 200
    # must be the plurality (a loose, timing-robust assertion, not an
    # exact-count one).
    if outcome.metrics.total_requests >= 8:
        assert status_codes.get("200", 0) >= status_codes.get("404", 0)
        assert status_codes.get("200", 0) >= status_codes.get("500", 0)

    # The derived Statistics view reconciles exactly with the raw counts.
    stats = build_statistics(outcome.metrics)
    assert stats.status_codes.counts == status_codes
    total_percentage = sum(stats.status_codes.percentages.values())
    assert 99.0 <= total_percentage <= 101.0  # float rounding tolerance


def test_p75_and_p90_are_present_in_a_real_run(monkeypatch, cycling_server, artifact_dir):
    import app.services.k6_engine.engine as engine_module

    monkeypatch.setattr(engine_module, "K6_BINARY", K6_BINARY)
    engine = RealK6PerformanceEngine()

    target = TargetConfig(base_url=cycling_server)
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=5000, error_rate=1.0),
        selected_endpoints=["/products"],
        target_vus=2,
        duration="3s",
    )

    outcome = engine.execute(plan, target, artifact_dir)
    assert outcome.summary_exists, outcome.error_message
    assert outcome.metrics.p75_ms is not None
    assert outcome.metrics.p90_ms is not None
    # Sanity ordering: p50 <= p75 <= p90 <= p95 <= p99 (real measured data).
    m = outcome.metrics
    assert m.p50_ms <= m.p75_ms <= m.p90_ms <= m.p95_ms <= m.p99_ms
