"""Phase-1 golden test: hardcoded TestPlan -> real k6 subprocess against a
target -> real result JSON -> deterministic metrics -> TestResult, driven
entirely through the HTTP API. Uses the ReferenceK6Engine placeholder
(app/services/reference_k6_engine.py) since Developer 2's real engine does
not exist yet -- but the k6 execution itself is real, not mocked.
"""

import time


def test_golden_path_baseline_checkout(client, stub_target_url):
    create_resp = client.post(
        "/api/v1/runs",
        json={"plan_id": "baseline_checkout", "target": {"base_url": stub_target_url}},
    )
    assert create_resp.status_code == 201, create_resp.text
    run_id = create_resp.json()["run_id"]
    assert create_resp.json()["status"] in ("QUEUED", "RUNNING", "COMPLETED")

    status = None
    status_body = None
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        status_resp = client.get(f"/api/v1/runs/{run_id}")
        assert status_resp.status_code == 200
        status_body = status_resp.json()
        status = status_body["status"]
        if status in ("COMPLETED", "EXECUTION_ERROR", "CANCELLED"):
            break
        time.sleep(0.5)

    assert status == "COMPLETED", f"run ended in state {status}: {status_body}"

    result_resp = client.get(f"/api/v1/runs/{run_id}/result")
    assert result_resp.status_code == 200, result_resp.text
    result = result_resp.json()

    assert result["run_id"] == run_id
    assert result["threshold_status"] in ("PASS", "FAIL")

    metrics = result["metrics"]
    for key in (
        "p50_ms",
        "p95_ms",
        "p99_ms",
        "rps",
        "total_requests",
        "failed_requests",
        "error_rate",
        "duration_s",
    ):
        assert key in metrics, f"missing metric: {key}"

    assert metrics["total_requests"] > 0
    assert metrics["failed_requests"] == 0  # stub target always returns 200
    assert metrics["error_rate"] == 0.0
