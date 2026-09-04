def test_rejects_neither_plan_nor_plan_id(client):
    resp = client.post("/api/v1/runs", json={"target": {"base_url": "http://127.0.0.1:1"}})
    assert resp.status_code == 422


def test_rejects_both_plan_and_plan_id(client):
    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 10,
        "duration": "5s",
        "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.01},
        "selected_endpoints": ["/products"],
    }
    resp = client.post(
        "/api/v1/runs",
        json={"plan": inline_plan, "plan_id": "baseline_checkout", "target": {"base_url": "http://127.0.0.1:1"}},
    )
    assert resp.status_code == 422


def test_unknown_plan_id_returns_404(client):
    resp = client.post(
        "/api/v1/runs",
        json={"plan_id": "does_not_exist", "target": {"base_url": "http://127.0.0.1:1"}},
    )
    assert resp.status_code == 404


def test_unknown_run_id_returns_404(client):
    resp = client.get("/api/v1/runs/does-not-exist")
    assert resp.status_code == 404
