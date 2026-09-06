"""Regression test for a real observed bug: `models.Base.metadata.create_all()`
(app/storage/db.py::init_db) only creates tables that don't exist yet -- it
never ALTERs an existing table to add a column a model gained later. A real
database file created before Session 5 added `p75_ms`/`p90_ms`/
`status_codes_json` to `TestResultRecord` kept its old physical schema
forever; every subsequent INSERT raised `sqlite3.OperationalError: table
test_results has no column named p75_ms`, uncaught, silently stranding
every run at RUNNING (see tests/test_failure_semantics.py::
test_persistence_failure_after_a_healthy_run_is_execution_error_not_stuck_running
for the run_service half of this fix).

`_add_missing_columns()` closes this gap: after `create_all()`, it inspects
each already-existing table and ALTERs in any column the ORM model has that
the physical table doesn't -- exactly the DB file's real starting condition
in production.
"""
from sqlalchemy import text

from app.schemas.enums import ResultClassification
from app.storage import repository
from app.storage.db import SessionLocal, _add_missing_columns, engine, init_db
from tests.fakes import make_metrics


def _actual_columns(table_name: str) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(text(f'PRAGMA table_info("{table_name}")')).fetchall()
    return {row[1] for row in rows}


def test_add_missing_columns_restores_a_column_dropped_from_an_existing_table():
    """Simulates the real production condition (a database file whose table
    predates a column the model later gained) by dropping a column SQLite
    already has, then proving `_add_missing_columns()` adds it back --
    without needing to touch any other row or column."""
    init_db()  # baseline: schema is already fully up to date
    assert "status_codes_json" in _actual_columns("test_results")

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE test_results DROP COLUMN status_codes_json"))
    assert "status_codes_json" not in _actual_columns("test_results")

    _add_missing_columns()

    assert "status_codes_json" in _actual_columns("test_results")


def test_add_missing_columns_is_idempotent_and_never_errors_on_a_fully_current_schema():
    """Must be safe to call on every startup (init_db() calls it
    unconditionally), including when nothing is actually missing."""
    init_db()
    _add_missing_columns()  # second call, nothing missing -- must not raise
    _add_missing_columns()  # a third time for good measure


def test_add_missing_columns_preserves_existing_row_data():
    """The new column must be added alongside existing rows, not by
    recreating the table and losing data (a real risk with some
    'workaround' migration approaches that copy-and-drop instead of
    ALTER ... ADD COLUMN)."""
    init_db()
    db = SessionLocal()
    try:
        run = repository.create_run(
            db, plan_id=repository.save_plan(db, _minimal_plan()).id,
            target_base_url="http://127.0.0.1:1", artifact_dir="/tmp/migration-test",
        )
        repository.save_result(db, run.id, make_metrics(), ResultClassification.PASS, [])
    finally:
        db.close()

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE test_results DROP COLUMN status_codes_json"))

    _add_missing_columns()

    db = SessionLocal()
    try:
        result = repository.get_result(db, run.id)
    finally:
        db.close()
    assert result is not None
    assert result.p50_ms == make_metrics().p50_ms  # pre-existing row's data survived intact
    assert result.status_codes_json is None  # new column, no backfill -- same as every other additive column


def _minimal_plan():
    from app.schemas.enums import ObjectiveType, PayloadStrategy, TestType
    from app.schemas.test_plan import FixedLoadPlan, Thresholds

    return FixedLoadPlan(
        test_type=TestType.baseline,
        objective_type=ObjectiveType.fixed_load,
        thresholds=Thresholds(p95_latency_ms=1000, error_rate=0.05),
        selected_endpoints=["/products"],
        payload_strategy=PayloadStrategy.normal,
        target_vus=10,
        duration="10s",
    )
