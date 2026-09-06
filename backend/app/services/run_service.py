"""Run lifecycle orchestration. Owns state transitions and the
execution-failure-vs-performance-failure distinction. Never computes
metrics itself -- that is the performance engine's job.
"""

import logging
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import ARTIFACTS_DIR, DEMO_PLANS_DIR
from app.schemas.run import RunCreateRequest
from app.schemas.test_plan import TargetConfig, TestPlan
from app.services import target_context_store
from app.services.performance_engine import PerformanceEngine
from app.services.secret_redaction import redact_secrets
from app.services.target_auth_secrets import auth_secret_values
from app.services.target_context_store import TargetContext
from app.services.target_url_safety import validate_target_url_safety
from app.services.target_validation import validate_target_compatibility
from app.services.workload_limits import validate_workload_limits
from app.storage import repository
from app.storage.db import SessionLocal
from app.storage.models import TestRunRecord

logger = logging.getLogger("run_service")


class PlanNotFoundError(Exception):
    pass


def _load_hardcoded_plan(plan_id: str) -> TestPlan:
    import json

    from pydantic import TypeAdapter

    path = DEMO_PLANS_DIR / f"{plan_id}.json"
    if not path.exists():
        raise PlanNotFoundError(f"no hardcoded plan named '{plan_id}' in {DEMO_PLANS_DIR}")
    return TypeAdapter(TestPlan).validate_python(json.loads(path.read_text()))


def create_run(db: Session, request: RunCreateRequest) -> TestRunRecord:
    """Validates the plan (via Pydantic parsing, already done by this point
    for inline plans; explicit lookup+parse for plan_id), persists it, and
    creates a QUEUED TestRun. Does not execute anything."""

    plan: TestPlan = request.plan if request.plan is not None else _load_hardcoded_plan(request.plan_id)

    # Authoritative workload safety gate. Runs for every plan source
    # (inline or hardcoded) before anything is persisted or reaches k6.
    # Cheap and local -- checked before the network-dependent target gate
    # below.
    validate_workload_limits(plan)

    # SSRF gate (app/services/target_url_safety.py): rejects a target whose
    # resolved address is on the fixed blocklist (cloud metadata always;
    # private/loopback only under TARGET_SSRF_POLICY=block_private).
    # Local/synchronous DNS lookup, no HTTP request -- cheaper than the
    # target-compatibility gate below, so it runs first.
    validate_target_url_safety(request.target.base_url)
    if request.target.openapi_url:
        validate_target_url_safety(request.target.openapi_url)

    # Target-compatibility gate (see app/services/target_validation.py for
    # the full rationale): only rejects when the target was reachable and
    # demonstrably lacks a selected endpoint. An unreachable target is not
    # rejected here -- deferred to execute_run, unchanged from before this
    # gate existed.
    validate_target_compatibility(plan, request.target)

    plan_record = repository.save_plan(db, plan)
    artifact_dir = ARTIFACTS_DIR / "pending"  # replaced below once run id exists
    run_record = repository.create_run(
        db,
        plan_id=plan_record.id,
        target_base_url=request.target.base_url,
        artifact_dir=str(artifact_dir),
    )

    # Artifact dir is keyed by run_id, which only exists after creation.
    real_artifact_dir = ARTIFACTS_DIR / run_record.id
    real_artifact_dir.mkdir(parents=True, exist_ok=True)
    run_record.artifact_dir = str(real_artifact_dir)
    db.commit()
    db.refresh(run_record)

    # request.target.openapi_url / .auth are NEVER persisted to the DB
    # (TestRunRecord only ever stored target_base_url -- unchanged by this
    # work) -- carried forward in-memory only, for execute_run's later
    # background-task reconstruction of the full TargetConfig. See
    # app/services/target_context_store.py for why this exists and its
    # documented single-process limitation.
    target_context_store.put(
        run_record.id,
        TargetContext(openapi_url=request.target.openapi_url, auth=request.target.auth),
    )

    return run_record


def execute_run(run_id: str, engine: PerformanceEngine) -> None:
    """Background task body. Opens its own DB session because it runs
    outside the request's session lifecycle (FastAPI BackgroundTasks run
    after the response, in a threadpool)."""

    db = SessionLocal()
    try:
        run_record = repository.get_run(db, run_id)
        if run_record is None:
            logger.error("execute_run: unknown run_id=%s", run_id)
            return

        plan_record = repository.get_plan(db, run_record.plan_id)
        plan = repository.load_plan_model(plan_record)
        # request.target.openapi_url / .auth never reached the DB (see
        # create_run above) -- recovered here from the same in-memory store,
        # keyed by run_id. Absent (process restarted, or a run created
        # before this store existed) simply means "no override / no auth",
        # exactly the pre-existing behavior.
        context = target_context_store.get(run_id)
        target = TargetConfig(
            base_url=run_record.target_base_url,
            openapi_url=context.openapi_url if context else None,
            auth=context.auth if context else None,
        )
        artifact_directory = Path(run_record.artifact_dir)

        repository.mark_run_running(db, run_id)

        try:
            outcome = engine.execute(plan, target, artifact_directory)
        except Exception as exc:  # engine raised -> definite execution failure
            logger.exception("execute_run: engine raised for run_id=%s", run_id)
            message = redact_secrets(f"engine raised: {exc}", auth_secret_values(target))
            repository.mark_run_execution_error(db, run_id, message)
            return

        # --- Execution result distinction (see docs/performance_engine_interface.md) ---
        # summary_exists True  -> the engine already confirmed exit_code == 0
        #                         AND a usable results artifact -- a
        #                         legitimate performance result, whether
        #                         threshold_status is PASS or FAIL.
        # summary_exists False -> actual execution failure (this covers a
        #                         non-zero exit_code even when a results
        #                         artifact happens to exist on disk -- the
        #                         engine is responsible for that check, not
        #                         this function). Must never be
        #                         reinterpreted as a performance FAIL.
        if outcome.summary_exists and outcome.metrics is not None and outcome.threshold_status is not None:
            # k6 already ran successfully at this point -- a failure to
            # PERSIST that result (e.g. a schema mismatch on an old database
            # file) must still resolve the run to a terminal state. Without
            # this, an exception here propagated uncaught out of the
            # BackgroundTask and left the run at RUNNING forever, even
            # though k6 itself had already finished (confirmed root cause of
            # a real "run never completes" bug).
            try:
                repository.save_result(
                    db, run_id, outcome.metrics, outcome.threshold_status, outcome.threshold_violations
                )
                repository.mark_run_completed(db, run_id)
            except Exception as exc:
                logger.exception("execute_run: failed to persist result for run_id=%s", run_id)
                repository.mark_run_execution_error(db, run_id, f"failed to persist run result: {exc}")
        else:
            message = outcome.error_message or (
                f"k6 exited {outcome.exit_code} with no summary artifact"
            )
            repository.mark_run_execution_error(db, run_id, message)
    finally:
        # The run has reached a terminal state (or failed to even start) --
        # the ephemeral auth/openapi_url context, if any, is no longer
        # needed and must not linger in memory past this point.
        target_context_store.discard(run_id)
        db.close()
