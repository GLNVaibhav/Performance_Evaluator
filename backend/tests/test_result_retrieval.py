"""GET /api/v1/runs/{id}/result behavior across every RunState, including
states not reachable through the current API (CANCELLED has no producer
endpoint yet) -- driven by directly manipulating the persisted state so
the retrieval contract itself is verified independent of how a run gets
there.
"""

from app.schemas.enums import RunState
from app.schemas.run import RunCreateRequest
from app.schemas.test_plan import TargetConfig
from app.services import run_service
from app.storage import repository


def _create_baseline_run(db_session):
    request = RunCreateRequest(plan_id="baseline_checkout", target=TargetConfig(base_url="http://127.0.0.1:1"))
    return run_service.create_run(db_session, request)


def test_result_409_while_queued(client, db_session):
    run = _create_baseline_run(db_session)
    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 409


def test_result_409_while_running(client, db_session):
    run = _create_baseline_run(db_session)
    repository.mark_run_running(db_session, run.id)
    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 409


def test_result_409_when_cancelled(client, db_session):
    run = _create_baseline_run(db_session)
    run_record = repository.get_run(db_session, run.id)
    run_record.state = RunState.CANCELLED.value
    db_session.commit()

    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 409


def test_result_422_when_execution_error(client, db_session):
    run = _create_baseline_run(db_session)
    repository.mark_run_execution_error(db_session, run.id, "simulated execution failure")

    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 422


def test_completed_without_result_is_500_not_silent_success(client, db_session):
    """A COMPLETED run with no TestResult row indicates a bug in
    run_service's completion path -- it must surface as a server error,
    never as a quiet 200 or a fabricated result."""

    run = _create_baseline_run(db_session)
    repository.mark_run_completed(db_session, run.id)  # no save_result() call

    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 500
