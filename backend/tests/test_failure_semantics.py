"""Blocker 4: prove the run lifecycle never confuses an execution failure
with a performance failure. Uses a fake PerformanceEngine at the service
boundary (run_service.execute_run) so these are deterministic and don't
depend on real k6 -- the real-k6 path stays covered separately by
test_golden_path.py.
"""

from app.schemas.enums import ResultClassification, RunState
from app.schemas.run import RunCreateRequest
from app.schemas.test_plan import TargetConfig
from app.services import run_service
from app.storage import repository
from tests.fakes import (
    FakePerformanceEngine,
    execution_error_outcome,
    performance_fail_outcome,
    performance_pass_outcome,
)


def _create_baseline_run(db_session):
    request = RunCreateRequest(plan_id="baseline_checkout", target=TargetConfig(base_url="http://127.0.0.1:1"))
    return run_service.create_run(db_session, request)


def _execute(db_session, run_id, engine):
    """run_service.execute_run opens its own DB session (matches
    production: the background task's session is independent of the
    request session). Expire db_session's identity map afterwards so the
    test's own reads see the committed rows instead of stale cached
    objects from before execution."""

    run_service.execute_run(run_id, engine)
    db_session.expire_all()


def test_healthy_success_is_completed_with_pass(db_session):
    """TEST C -- execution succeeded, summary exists, thresholds pass."""

    run = _create_baseline_run(db_session)
    _execute(db_session, run.id, FakePerformanceEngine(outcome=performance_pass_outcome()))

    updated = repository.get_run(db_session, run.id)
    assert RunState(updated.state) == RunState.COMPLETED

    result = repository.get_result(db_session, run.id)
    assert result is not None
    assert result.threshold_status == ResultClassification.PASS.value


def test_performance_failure_is_completed_not_execution_error(db_session):
    """TEST A -- execution succeeded, summary + metrics exist, thresholds
    failed. This is a PERFORMANCE FAILURE: COMPLETED + a TestResult
    classified FAIL, never EXECUTION_ERROR."""

    run = _create_baseline_run(db_session)
    _execute(db_session, run.id, FakePerformanceEngine(outcome=performance_fail_outcome()))

    updated = repository.get_run(db_session, run.id)
    assert RunState(updated.state) == RunState.COMPLETED, (
        "a failed threshold on a test that actually ran is a real result, not an execution error"
    )

    result = repository.get_result(db_session, run.id)
    assert result is not None
    assert result.threshold_status == ResultClassification.FAIL.value


def test_missing_summary_is_execution_error_not_performance_fail(db_session):
    """TEST B (variant: summary_exists=False) -- no TestResult must ever be
    created, and the run must never read as a performance FAIL."""

    run = _create_baseline_run(db_session)
    _execute(db_session, run.id, FakePerformanceEngine(outcome=execution_error_outcome("no summary produced")))

    updated = repository.get_run(db_session, run.id)
    assert RunState(updated.state) == RunState.EXECUTION_ERROR
    assert repository.get_result(db_session, run.id) is None
    assert "no summary produced" in updated.error_message


def test_engine_exception_is_execution_error_not_performance_fail(db_session):
    """TEST B (variant: engine raises, e.g. k6 process failure) -- same
    guarantee as the missing-summary case."""

    run = _create_baseline_run(db_session)
    _execute(db_session, run.id, FakePerformanceEngine(raise_error=True, raise_message="k6 process crashed"))

    updated = repository.get_run(db_session, run.id)
    assert RunState(updated.state) == RunState.EXECUTION_ERROR
    assert repository.get_result(db_session, run.id) is None
    assert "k6 process crashed" in updated.error_message


def test_persistence_failure_after_a_healthy_run_is_execution_error_not_stuck_running(db_session, monkeypatch):
    """Regression test for a real observed bug: k6 executed successfully
    (summary_exists=True, metrics present, threshold evaluated) but
    persisting that result raised (in production: sqlite3.OperationalError
    from a database file whose test_results table predated a column the
    ORM model later gained -- see app/storage/db.py::_add_missing_columns).
    That exception was not caught anywhere between engine.execute()
    returning and the run reaching a terminal state, so it propagated out
    of the BackgroundTask uncaught and the run stayed RUNNING forever, even
    though k6 itself had already finished. A run must always reach a
    terminal state -- never be left RUNNING by a failure that happens
    strictly after execution succeeded."""

    def _raise(*args, **kwargs):
        raise RuntimeError("simulated persistence failure (e.g. stale DB schema)")

    monkeypatch.setattr(repository, "save_result", _raise)

    run = _create_baseline_run(db_session)
    _execute(db_session, run.id, FakePerformanceEngine(outcome=performance_pass_outcome()))

    updated = repository.get_run(db_session, run.id)
    assert RunState(updated.state) == RunState.EXECUTION_ERROR
    assert updated.state != RunState.RUNNING
    assert "persist" in updated.error_message.lower()
    assert repository.get_result(db_session, run.id) is None
