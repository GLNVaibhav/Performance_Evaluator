"""Release-gate integration tests: real processes, public HTTP APIs, real k6.

Run from the repository root after creating ``.venv``::

    .venv\\Scripts\\python.exe -m pytest backend/tests/integration -v

The test starts the canonical demo API and evaluator backend on ephemeral
loopback ports.  It deliberately never imports either app or service: every
run is created, polled, and retrieved through the evaluator's public API.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest


ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
K6_BINARY = Path(os.environ.get("K6_BINARY", r"C:\Program Files\k6\k6.exe"))
POLL_TIMEOUT_S = 35


def _port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_for(url: str) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            if httpx.get(url, timeout=1).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    raise RuntimeError(f"server did not become healthy: {url}")


def _plan(endpoint: str, *, p95: int, error_rate: float, duration: str = "2s") -> dict:
    return {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 2,
        "duration": duration,
        "thresholds": {"p95_latency_ms": p95, "error_rate": error_rate},
        "selected_endpoints": [endpoint],
        "assumptions": ["Dev-5 public API release validation"],
    }


@pytest.fixture(scope="session")
def services(tmp_path_factory):
    if not PYTHON.exists():
        pytest.skip("QA virtual environment is unavailable")
    if not K6_BINARY.exists():
        pytest.skip(f"real k6 binary is unavailable: {K6_BINARY}")

    demo_port, backend_port = _port(), _port()
    demo_url = f"http://127.0.0.1:{demo_port}"
    backend_url = f"http://127.0.0.1:{backend_port}/api/v1"
    state_dir = tmp_path_factory.mktemp("public-api-vertical-slice")
    env = os.environ.copy()
    env.update(
        {
            "K6_BINARY": str(K6_BINARY),
            "DATABASE_URL": f"sqlite:///{state_dir / 'backend.db'}",
            "ARTIFACTS_DIR": str(state_dir / "artifacts"),
            "K6_EXECUTION_TIMEOUT_S": "20",
        }
    )
    demo = subprocess.Popen(
        [str(PYTHON), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(demo_port)],
        cwd=ROOT / "demo-api",
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    backend = subprocess.Popen(
        [str(PYTHON), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(backend_port)],
        cwd=ROOT / "backend",
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        _wait_for(f"{demo_url}/health")
        _wait_for(f"{backend_url}/health")
        yield {"demo": demo_url, "backend": backend_url, "artifacts": state_dir / "artifacts"}
    finally:
        for process in (backend, demo):
            process.terminate()
        for process in (backend, demo):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


def _run(client: httpx.Client, backend_url: str, target: str, plan: dict) -> tuple[str, dict]:
    created = client.post(f"{backend_url}/runs", json={"plan": plan, "target": {"base_url": target}})
    assert created.status_code == 201, created.text
    run_id = created.json()["run_id"]
    deadline = time.monotonic() + POLL_TIMEOUT_S
    while time.monotonic() < deadline:
        status = client.get(f"{backend_url}/runs/{run_id}")
        assert status.status_code == 200, status.text
        state = status.json()
        if state["status"] in {"COMPLETED", "EXECUTION_ERROR"}:
            return run_id, state
        time.sleep(0.15)
    pytest.fail(f"run {run_id} did not reach a terminal state in {POLL_TIMEOUT_S}s")


def _set_mode(client: httpx.Client, demo_url: str, mode: str) -> None:
    response = client.post(f"{demo_url}/demo/mode", json={"mode": mode})
    assert response.status_code == 200, response.text
    assert client.get(f"{demo_url}/demo/mode").json()["mode"] == mode


def _assert_metrics(result: dict) -> None:
    metrics = result["metrics"]
    required = {"p50_ms", "p95_ms", "p99_ms", "average_ms", "max_ms", "rps", "total_requests", "failed_requests", "error_rate"}
    assert required <= metrics.keys()
    assert metrics["total_requests"] >= metrics["failed_requests"]
    assert 0 <= metrics["error_rate"] <= 1
    assert metrics["p50_ms"] <= metrics["p95_ms"] <= metrics["p99_ms"]


def test_public_api_modes_and_metrics_contract(services):
    """A-C: live mode switches prove GET and POST paths use the real target."""
    with httpx.Client(timeout=10) as client:
        openapi = client.get(f"{services['demo']}/openapi.json")
        assert openapi.status_code == 200
        paths = openapi.json()["paths"]
        # FastAPI publishes the logical item route as /products/{product_id}
        # (rather than the brief's illustrative {id} parameter spelling).
        assert {"/products", "/products/{product_id}", "/cart", "/checkout"} <= paths.keys()

        _set_mode(client, services["demo"], "normal")
        healthy_id, healthy_state = _run(client, services["backend"], services["demo"], _plan("/products", p95=2000, error_rate=0.05))
        assert healthy_state["status"] == "COMPLETED"
        healthy = client.get(f"{services['backend']}/runs/{healthy_id}/result")
        assert healthy.status_code == 200, healthy.text
        assert healthy.json()["threshold_status"] == "PASS"
        _assert_metrics(healthy.json())
        assert (services["artifacts"] / healthy_id / "results.json").exists()

        _set_mode(client, services["demo"], "checkout_bottleneck")
        slow_id, slow_state = _run(client, services["backend"], services["demo"], _plan("/checkout", p95=100, error_rate=0.5, duration="3s"))
        assert slow_state["status"] == "COMPLETED"
        slow = client.get(f"{services['backend']}/runs/{slow_id}/result")
        assert slow.status_code == 200, slow.text
        assert slow.json()["threshold_status"] == "FAIL"
        assert slow.json()["metrics"]["p95_ms"] > 100
        assert (services["artifacts"] / slow_id / "results.json").exists()

        _set_mode(client, services["demo"], "error_injection")
        error_id, error_state = _run(client, services["backend"], services["demo"], _plan("/products", p95=2000, error_rate=0.01, duration="3s"))
        assert error_state["status"] == "COMPLETED"
        errored = client.get(f"{services['backend']}/runs/{error_id}/result")
        assert errored.status_code == 200, errored.text
        assert errored.json()["threshold_status"] == "FAIL"
        assert errored.json()["metrics"]["error_rate"] > 0.01
        assert errored.json()["metrics"]["failed_requests"] > 0
        assert (services["artifacts"] / error_id / "results.json").exists()
        _set_mode(client, services["demo"], "normal")


def test_public_api_unavailable_target_is_execution_error(services):
    with httpx.Client(timeout=10) as client:
        run_id, state = _run(client, services["backend"], "http://127.0.0.1:1", _plan("/products", p95=2000, error_rate=0.05))
        assert state["status"] == "EXECUTION_ERROR"
        result = client.get(f"{services['backend']}/runs/{run_id}/result")
        assert result.status_code == 422
        assert not (services["artifacts"] / run_id / "results.json").exists()


def test_public_api_rejects_workloads_above_server_limits(services):
    with httpx.Client(timeout=10) as client:
        over_vus = _plan("/products", p95=2000, error_rate=0.05)
        over_vus["target_vus"] = 2001
        response = client.post(
            f"{services['backend']}/runs",
            json={"plan": over_vus, "target": {"base_url": services["demo"]}},
        )
        assert response.status_code == 422, response.text

        over_duration = _plan("/products", p95=2000, error_rate=0.05, duration="91s")
        response = client.post(
            f"{services['backend']}/runs",
            json={"plan": over_duration, "target": {"base_url": services["demo"]}},
        )
        assert response.status_code == 422, response.text


def test_public_api_nonzero_k6_exit_never_persists_result(services, tmp_path):
    """E: a wrapper writes valid JSON then exits non-zero, exercising precedence."""
    wrapper = tmp_path / "failing-k6.cmd"
    summary = json.dumps({"metrics": {"http_req_duration": {"values": {"med": 1, "p(95)": 1, "p(99)": 1, "avg": 1, "max": 1}}, "http_reqs": {"values": {"count": 1, "rate": 1}}, "http_req_failed": {"values": {"value": 0}}}})
    wrapper.write_text("@echo off\nset RESULT=\n:loop\nif \"%~1\"==\"\" goto done\nif /I \"%~1\"==\"--summary-export\" set \"RESULT=%~2\"\nshift\ngoto loop\n:done\n> \"%RESULT%\" echo " + summary + "\nexit /b 7\n")
    port = _port()
    backend_url = f"http://127.0.0.1:{port}/api/v1"
    state_dir = tmp_path / "nonzero-state"
    env = os.environ.copy()
    env.update(
        {
            "K6_BINARY": str(wrapper),
            "DATABASE_URL": f"sqlite:///{state_dir / 'backend.db'}",
            "ARTIFACTS_DIR": str(state_dir / "artifacts"),
        }
    )
    backend = subprocess.Popen(
        [str(PYTHON), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT / "backend", env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        _wait_for(f"{backend_url}/health")
        with httpx.Client(timeout=10) as client:
            run_id, state = _run(client, backend_url, services["demo"], _plan("/products", p95=2000, error_rate=0.05))
            assert state["status"] == "EXECUTION_ERROR"
            result = client.get(f"{backend_url}/runs/{run_id}/result")
            assert result.status_code == 422
            assert (state_dir / "artifacts" / run_id / "results.json").exists()
    finally:
        backend.terminate()
        try:
            backend.wait(timeout=5)
        except subprocess.TimeoutExpired:
            backend.kill()
