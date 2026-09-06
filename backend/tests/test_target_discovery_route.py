"""POST /api/v1/targets/discover -- OpenAPI discovery + sanitized auth
metadata. Side-effect-free (no run, no DB write, no engine call), mirroring
POST /api/v1/intents/compile's boundary. Uses the real, live demo API
(skipped if not reachable), exactly like tests/test_target_validation.py.
"""
import os

import httpx
import pytest

DEMO_API_URL = os.environ.get("DEMO_API_URL", "http://127.0.0.1:8080")


@pytest.fixture(autouse=True)
def _require_demo_api():
    try:
        resp = httpx.get(f"{DEMO_API_URL}/health", timeout=3.0)
        assert resp.status_code == 200
    except Exception:
        pytest.skip(f"canonical demo API not reachable at {DEMO_API_URL} -- start it with 'python run.py'")


def test_discovery_of_reachable_target_returns_endpoints_and_no_auth(client):
    resp = client.post("/api/v1/targets/discover", json={"base_url": DEMO_API_URL})
    assert resp.status_code == 200
    body = resp.json()
    assert body["reachable"] is True
    assert "/products" in body["endpoints"]
    assert body["auth"] == {"auth_available": False, "auth_type": None}
    assert body["error"] is None


def test_discovery_reports_sanitized_auth_metadata_without_the_secret(client):
    resp = client.post(
        "/api/v1/targets/discover",
        json={
            "base_url": DEMO_API_URL,
            "auth": {"type": "bearer", "token": "super-secret-value-12345"},
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["auth"] == {"auth_available": True, "auth_type": "bearer"}
    # The core property: the raw secret must never appear anywhere in the
    # response, under any key.
    assert "super-secret-value-12345" not in resp.text


def test_discovery_of_unreachable_target_reports_not_reachable_not_an_error_status(client):
    resp = client.post("/api/v1/targets/discover", json={"base_url": "http://127.0.0.1:1"})
    assert resp.status_code == 200  # discovery outcome, not an HTTP failure
    body = resp.json()
    assert body["reachable"] is False
    assert body["endpoints"] == []
    assert body["error"] is not None


def test_discovery_never_creates_a_run(client, db_session):
    from app.storage import repository

    runs_before = db_session.query(repository.TestRunRecord).count()
    client.post("/api/v1/targets/discover", json={"base_url": DEMO_API_URL})
    runs_after = db_session.query(repository.TestRunRecord).count()
    assert runs_after == runs_before


def test_discovery_rejects_malformed_base_url(client):
    resp = client.post("/api/v1/targets/discover", json={"base_url": "not-a-url"})
    assert resp.status_code == 422


def test_discovery_rejects_unsupported_auth_type(client):
    resp = client.post(
        "/api/v1/targets/discover",
        json={"base_url": DEMO_API_URL, "auth": {"type": "oauth2", "token": "t"}},
    )
    assert resp.status_code == 422


def test_discovery_rejects_missing_required_auth_field(client):
    resp = client.post(
        "/api/v1/targets/discover",
        json={"base_url": DEMO_API_URL, "auth": {"type": "api_key_header", "api_key": "k"}},
    )
    assert resp.status_code == 422
