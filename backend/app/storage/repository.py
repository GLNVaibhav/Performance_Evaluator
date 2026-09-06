import json
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy.orm import Session

from app.schemas.enums import RunState
from app.schemas.test_plan import TestPlan
from app.schemas.test_result import EndpointMetrics, MetricsSummary, TestResult, ThresholdViolation
from app.storage.models import TestPlanRecord, TestResultRecord, TestRunRecord


def new_id() -> str:
    return uuid.uuid4().hex


def save_plan(db: Session, plan: TestPlan) -> TestPlanRecord:
    record = TestPlanRecord(
        id=new_id(),
        objective_type=plan.objective_type.value,
        test_type=plan.test_type.value,
        plan_json=plan.model_dump_json(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def get_plan(db: Session, plan_id: str) -> Optional[TestPlanRecord]:
    return db.get(TestPlanRecord, plan_id)


def create_run(db: Session, plan_id: str, target_base_url: str, artifact_dir: str) -> TestRunRecord:
    record = TestRunRecord(
        id=new_id(),
        plan_id=plan_id,
        target_base_url=target_base_url,
        state=RunState.QUEUED.value,
        artifact_dir=artifact_dir,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def get_run(db: Session, run_id: str) -> Optional[TestRunRecord]:
    return db.get(TestRunRecord, run_id)


def list_runs(db: Session, limit: int = 20) -> List[TestRunRecord]:
    """Most-recent-first run history. Read-only, additive -- does not
    touch the run lifecycle (create_run/mark_run_*) or any protected
    execution-core boundary."""
    return (
        db.query(TestRunRecord)
        .order_by(TestRunRecord.created_at.desc())
        .limit(limit)
        .all()
    )


def mark_run_running(db: Session, run_id: str) -> None:
    run = db.get(TestRunRecord, run_id)
    if run is None:
        return
    run.state = RunState.RUNNING.value
    run.started_at = datetime.now(timezone.utc)
    db.commit()


def mark_run_completed(db: Session, run_id: str) -> None:
    run = db.get(TestRunRecord, run_id)
    if run is None:
        return
    run.state = RunState.COMPLETED.value
    run.finished_at = datetime.now(timezone.utc)
    db.commit()


def mark_run_execution_error(db: Session, run_id: str, error_message: str) -> None:
    run = db.get(TestRunRecord, run_id)
    if run is None:
        return
    run.state = RunState.EXECUTION_ERROR.value
    run.error_message = error_message
    run.finished_at = datetime.now(timezone.utc)
    db.commit()


def save_result(
    db: Session,
    run_id: str,
    metrics: MetricsSummary,
    threshold_status,
    threshold_violations: Optional[List[ThresholdViolation]] = None,
) -> TestResultRecord:
    record = TestResultRecord(
        id=new_id(),
        run_id=run_id,
        p50_ms=metrics.p50_ms,
        p75_ms=metrics.p75_ms,
        p90_ms=metrics.p90_ms,
        p95_ms=metrics.p95_ms,
        p99_ms=metrics.p99_ms,
        average_ms=metrics.average_ms,
        max_ms=metrics.max_ms,
        rps=metrics.rps,
        total_requests=metrics.total_requests,
        failed_requests=metrics.failed_requests,
        error_rate=metrics.error_rate,
        duration_s=metrics.duration_s,
        threshold_status=threshold_status.value,
        per_endpoint_json=(
            json.dumps([e.model_dump() for e in metrics.per_endpoint]) if metrics.per_endpoint else None
        ),
        threshold_violations_json=(
            json.dumps([v.model_dump() for v in threshold_violations]) if threshold_violations else None
        ),
        status_codes_json=(json.dumps(metrics.status_codes) if metrics.status_codes else None),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def get_result(db: Session, run_id: str) -> Optional[TestResultRecord]:
    return db.query(TestResultRecord).filter(TestResultRecord.run_id == run_id).first()


def load_plan_model(record: TestPlanRecord) -> TestPlan:
    from pydantic import TypeAdapter

    return TypeAdapter(TestPlan).validate_python(json.loads(record.plan_json))


def result_record_to_schema(record: TestResultRecord) -> TestResult:
    per_endpoint = (
        [EndpointMetrics(**e) for e in json.loads(record.per_endpoint_json)] if record.per_endpoint_json else []
    )
    threshold_violations = (
        [ThresholdViolation(**v) for v in json.loads(record.threshold_violations_json)]
        if record.threshold_violations_json
        else []
    )
    status_codes = json.loads(record.status_codes_json) if record.status_codes_json else {}
    return TestResult(
        run_id=record.run_id,
        metrics=MetricsSummary(
            p50_ms=record.p50_ms,
            p75_ms=record.p75_ms,
            p90_ms=record.p90_ms,
            p95_ms=record.p95_ms,
            p99_ms=record.p99_ms,
            average_ms=record.average_ms,
            max_ms=record.max_ms,
            rps=record.rps,
            total_requests=record.total_requests,
            failed_requests=record.failed_requests,
            error_rate=record.error_rate,
            duration_s=record.duration_s,
            per_endpoint=per_endpoint,
            status_codes=status_codes,
        ),
        threshold_status=record.threshold_status,
        evaluated_at=record.evaluated_at,
        threshold_violations=threshold_violations,
    )
