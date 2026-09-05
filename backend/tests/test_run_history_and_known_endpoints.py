"""Tests for the two P1 gap-analysis additions from the Dev-3 gate review
of commit 0375e2c: GET /api/v1/runs (history) and
GET /api/v1/intents/known-endpoints. Both are read-only and additive --
these tests also confirm neither touches the protected run lifecycle.
"""
from app.schemas.run import RunCreateRequest
from app.schemas.test_plan import TargetConfig
from app.services import run_service


def _create_baseline_run(db_session):
    request = RunCreateRequest(plan_id="baseline_checkout", target=TargetConfig(base_url="http://127.0.0.1:1"))
    return run_service.create_run(db_session, request)


def test_list_runs_returns_most_recent_first(client, db_session):
    run_a = _create_baseline_run(db_session)
    run_b = _create_baseline_run(db_session)

    resp = client.get("/api/v1/runs")
    assert resp.status_code == 200
    body = resp.json()
    ids = [r["run_id"] for r in body]

    assert run_a.id in ids
    assert run_b.id in ids
    assert ids.index(run_b.id) < ids.index(run_a.id)  # most recent (b) first


def test_list_runs_respects_limit(client, db_session):
    for _ in range(3):
        _create_baseline_run(db_session)

    resp = client.get("/api/v1/runs?limit=2")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


def test_list_runs_shape_matches_get_run_status(client, db_session):
    run = _create_baseline_run(db_session)

    list_resp = client.get("/api/v1/runs").json()
    single_resp = client.get(f"/api/v1/runs/{run.id}").json()
    entry = next(r for r in list_resp if r["run_id"] == run.id)

    assert entry == single_resp  # identical shape, not a parallel schema


def test_list_runs_never_creates_or_mutates_a_run(client, db_session, monkeypatch):
    """Read-only guarantee -- traps create_run/execute_run to prove
    listing never touches the run lifecycle."""
    import app.services.run_service as run_service_module

    def _fail_if_called(*a, **kw):
        raise AssertionError("GET /runs must never touch the run lifecycle")

    monkeypatch.setattr(run_service_module, "create_run", _fail_if_called)
    monkeypatch.setattr(run_service_module, "execute_run", _fail_if_called)

    resp = client.get("/api/v1/runs")
    assert resp.status_code == 200


def test_known_endpoints_returns_configured_set(client):
    resp = client.get("/api/v1/intents/known-endpoints")
    assert resp.status_code == 200
    body = resp.json()
    assert "/products" in body["endpoints"]
    assert "/products/{product_id}" in body["endpoints"]
    assert "/checkout" in body["endpoints"]


def test_known_endpoints_matches_what_the_llm_interpreter_actually_enforces():
    """Not just "returns something" -- proves it's the SAME list the
    containment check in llm_intent_interpreter.py uses, not a second,
    independently-maintained copy that could drift."""
    from app.core.config import LLM_KNOWN_ENDPOINTS
    from app.services.llm_intent_interpreter import LLMIntentInterpreter

    interpreter = LLMIntentInterpreter(api_key="test-key")
    assert interpreter._available_endpoints == LLM_KNOWN_ENDPOINTS
