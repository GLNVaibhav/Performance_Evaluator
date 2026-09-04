"""MANDATORY (section 18.G): real k6 subprocess against the actual
canonical Dev-4 demo API. No mocks anywhere in this file. Requires the
demo API running at DEMO_API_URL and a real k6 binary at K6_BINARY.

Run manually (not part of default `pytest tests/`, since it depends on
external processes):

    cd demo-api && python run.py &
    K6_BINARY=/path/to/k6 DEMO_API_URL=http://127.0.0.1:8080 \\
        PYTHONPATH=backend python3 -m pytest backend/tests/k6_engine/test_real_k6_integration.py -v -s
"""
import os
import shutil
import tempfile
from pathlib import Path

import httpx
import pytest

from app.schemas.enums import ResultClassification
from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.engine import RealK6PerformanceEngine

DEMO_API_URL = os.environ.get("DEMO_API_URL", "http://127.0.0.1:8080")
K6_BINARY = os.environ.get("K6_BINARY", "k6")

pytestmark = pytest.mark.skipif(
    shutil.which(K6_BINARY) is None and not Path(K6_BINARY).exists(),
    reason=f"k6 binary not found at '{K6_BINARY}' -- set K6_BINARY",
)


@pytest.fixture(autouse=True)
def _require_demo_api():
    try:
        resp = httpx.get(f"{DEMO_API_URL}/health", timeout=3.0)
        assert resp.status_code == 200
    except Exception:
        pytest.skip(f"canonical demo API not reachable at {DEMO_API_URL} -- start it with 'python run.py'")


@pytest.fixture(autouse=True)
def _reset_mode():
    httpx.post(f"{DEMO_API_URL}/demo/mode", json={"mode": "normal"})
    yield
    httpx.post(f"{DEMO_API_URL}/demo/mode", json={"mode": "normal"})


@pytest.fixture()
def artifact_dir():
    d = Path(tempfile.mkdtemp(prefix="pe-real-k6-"))
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _engine(monkeypatch):
    import app.services.k6_engine.engine as engine_module

    monkeypatch.setattr(engine_module, "K6_BINARY", K6_BINARY)
    return RealK6PerformanceEngine()


def test_scenario_a_normal_mode_healthy_endpoint_completes_and_passes(monkeypatch, artifact_dir):
    httpx.post(f"{DEMO_API_URL}/demo/mode", json={"mode": "normal"})
    engine = _engine(monkeypatch)
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=2000, error_rate=0.05),
        selected_endpoints=["/products"],
        target_vus=10,
        duration="8s",
    )
    outcome = engine.execute(plan, TargetConfig(base_url=DEMO_API_URL), artifact_dir)

    assert outcome.summary_exists, outcome.error_message
    assert outcome.metrics is not None
    assert outcome.metrics.total_requests > 0
    assert outcome.threshold_status == ResultClassification.PASS
    assert (artifact_dir / "results.json").exists()
    assert (artifact_dir / "script.js").exists()
    assert (artifact_dir / "stdout.log").exists()
    assert (artifact_dir / "stderr.log").exists()


def test_scenario_b_checkout_bottleneck_completes_but_fails_threshold(monkeypatch, artifact_dir):
    httpx.post(f"{DEMO_API_URL}/demo/mode", json={"mode": "checkout_bottleneck"})
    engine = _engine(monkeypatch)
    # CHECKOUT_DELAY_MS defaults to 800ms -- a 50ms p95 threshold is well
    # below the induced bottleneck, guaranteeing a genuine FAIL.
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=50, error_rate=0.5),
        selected_endpoints=["/checkout"],
        target_vus=5,
        duration="8s",
    )
    outcome = engine.execute(plan, TargetConfig(base_url=DEMO_API_URL), artifact_dir)

    assert outcome.summary_exists, outcome.error_message
    assert outcome.metrics is not None
    assert outcome.metrics.total_requests > 0
    assert outcome.metrics.p95_ms > 50  # the real, measured bottleneck latency
    assert outcome.threshold_status == ResultClassification.FAIL


def test_scenario_c_error_injection_completes_but_fails_threshold(monkeypatch, artifact_dir):
    httpx.post(f"{DEMO_API_URL}/demo/mode", json={"mode": "error_injection"})
    engine = _engine(monkeypatch)
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=2000, error_rate=0.01),  # strict: real injected rate is ~30%
        selected_endpoints=["/products"],
        target_vus=10,
        duration="8s",
    )
    outcome = engine.execute(plan, TargetConfig(base_url=DEMO_API_URL), artifact_dir)

    assert outcome.summary_exists, outcome.error_message
    assert outcome.metrics is not None
    assert outcome.metrics.error_rate > 0.01  # real, measured, not fabricated
    assert outcome.threshold_status == ResultClassification.FAIL


def test_scenario_d_unreachable_target_is_execution_error_with_no_test_result(monkeypatch, artifact_dir):
    engine = _engine(monkeypatch)
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=2000, error_rate=0.05),
        selected_endpoints=["/products"],
        target_vus=5,
        duration="5s",
    )
    # port 1 is a privileged, never-listening port -- guaranteed unreachable
    outcome = engine.execute(plan, TargetConfig(base_url="http://127.0.0.1:1"), artifact_dir)

    assert outcome.summary_exists is False
    assert outcome.metrics is None
    assert outcome.threshold_status is None
    assert outcome.error_message is not None
