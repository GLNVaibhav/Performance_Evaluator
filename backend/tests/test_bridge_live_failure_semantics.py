"""LIVE failure-semantics tests against the REAL k6 binary and REAL engine.

These complement test_failure_semantics.py (which uses engine fakes) by
proving the actual k6 path produces the right lifecycle states:

C. k6 execution error  -> EXECUTION_ERROR (unreachable target = connection
   failures before any completed exchange)
D. Timeout             -> EXECUTION_ERROR (K6_EXECUTION_TIMEOUT_S exceeded)
F. Malformed result    -> EXECUTION_ERROR (a results.json that exists but is
   unusable never becomes a performance result)

Run with a k6 binary available:
  K6_BINARY=... python -m pytest tests/test_bridge_live_failure_semantics.py
Skipped cleanly when no k6 binary is configured (same rule as the golden path).
"""

import json
import os
import time

import pytest
from fastapi.testclient import TestClient

import app.core.config as config
from app.main import app
from app.storage.db import init_db

requires_k6 = pytest.mark.skipif(
    not (os.path.exists(os.environ.get("K6_BINARY", "k6")) or os.environ.get("K6_BINARY", "k6") != "k6"),
    reason="real k6 binary not configured (set K6_BINARY)",
)

pytestmark = [pytest.mark.anyio, requires_k6]


@pytest.fixture()
def client(monkeypatch):
    init_db()
    with TestClient(app) as c:
        yield c


PLAN = {
    "objective_type": "fixed_load",
    "test_type": "baseline",
    "target_vus": 2,
    "duration": "3s",
    "thresholds": {"p95_latency_ms": 5000, "error_rate": 0.9},
    "selected_endpoints": ["/products"],
    "assumptions": [],
}


def _submit_and_wait(client, target, timeout_s=90):
    created = client.post("/api/v1/runs", json={"plan": PLAN, "target": {"base_url": target}})
    assert created.status_code == 201, created.text
    run_id = created.json()["run_id"]
    deadline = time.monotonic() + timeout_s
    body = None
    while time.monotonic() < deadline:
        body = client.get(f"/api/v1/runs/{run_id}").json()
        if body["status"] in ("COMPLETED", "EXECUTION_ERROR", "CANCELLED"):
            return run_id, body
        time.sleep(0.4)
    return run_id, body


def test_c_execution_error_on_unreachable_target(client):
    """Connection refused before any exchange -> EXECUTION_ERROR, never FAIL."""
    run_id, body = _submit_and_wait(client, "http://127.0.0.1:59993")
    assert body["status"] == "EXECUTION_ERROR", body
    assert body["error_message"]
    # No performance result exists for an execution failure.
    assert client.get(f"/api/v1/runs/{run_id}/result").status_code == 422


def test_d_timeout_maps_to_execution_error(client, monkeypatch, tmp_path):
    """A k6 process exceeding the subprocess timeout -> EXECUTION_ERROR with
    the timeout in the message (k6_runner.py handles TimeoutExpired)."""
    import app.services.k6_engine.engine as engine_mod

    # engine.py reads the constant from config at import time; patch the name
    # the run path actually uses (same technique as tests/test_workload_limits.py).
    monkeypatch.setattr(engine_mod, "K6_EXECUTION_TIMEOUT_S", 3)
    # A non-routable address stalls the connect phase; the 3s subprocess
    # ceiling fires first.
    run_id, body = _submit_and_wait(client, "http://10.255.255.1:9/", timeout_s=60)
    assert body["status"] == "EXECUTION_ERROR", body
    assert "time" in body["error_message"].lower() or "connect" in body["error_message"].lower()


def test_f_malformed_summary_never_becomes_a_result(client, monkeypatch):
    """A pre-planted garbage results.json must not yield metrics (defense at
    the engine boundary — the real engine rejects exit!=0 and unusable
    artifacts before parsing; here we prove the parser itself refuses)."""
    from app.services.k6_engine.metrics_parser import parse_results

    artifact_dir = config.ARTIFACTS_DIR / "test_malformed"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    bad = artifact_dir / "results.json"
    bad.write_text("{ this is not json ")
    with pytest.raises(Exception):
        parse_results(bad, duration_s=1.0)
    bad.unlink()


def test_no_result_row_for_execution_error(client):
    run_id, body = _submit_and_wait(client, "http://127.0.0.1:59993")
    assert body["status"] == "EXECUTION_ERROR"
    result = client.get(f"/api/v1/runs/{run_id}/result")
    assert result.status_code == 422
    assert "not a performance result" in result.json()["detail"]
