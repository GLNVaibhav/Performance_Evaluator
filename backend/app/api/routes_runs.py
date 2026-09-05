from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas.enums import RunState
from app.schemas.run import RunCreateRequest, RunCreateResponse, RunStatusResponse
from app.schemas.test_result import ArtifactRefs, TestResult
from app.services import run_service
from app.services.engine_provider import get_performance_engine
from app.services.workload_limits import WorkloadLimitExceededError
from app.storage import repository

router = APIRouter(prefix="/runs", tags=["runs"])


@router.post("", response_model=RunCreateResponse, status_code=201)
def create_run(
    request: RunCreateRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> RunCreateResponse:
    try:
        run_record = run_service.create_run(db, request)
    except run_service.PlanNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except WorkloadLimitExceededError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    background_tasks.add_task(run_service.execute_run, run_record.id, get_performance_engine())
    return RunCreateResponse(run_id=run_record.id, status=RunState(run_record.state))


@router.get("/{run_id}", response_model=RunStatusResponse)
def get_run_status(run_id: str, db: Session = Depends(get_db)) -> RunStatusResponse:
    run_record = repository.get_run(db, run_id)
    if run_record is None:
        raise HTTPException(status_code=404, detail="run not found")

    return RunStatusResponse(
        run_id=run_record.id,
        status=RunState(run_record.state),
        created_at=run_record.created_at,
        started_at=run_record.started_at,
        finished_at=run_record.finished_at,
        error_message=run_record.error_message,
    )


@router.get("/{run_id}/result", response_model=TestResult)
def get_run_result(run_id: str, db: Session = Depends(get_db)) -> TestResult:
    run_record = repository.get_run(db, run_id)
    if run_record is None:
        raise HTTPException(status_code=404, detail="run not found")

    state = RunState(run_record.state)
    if state in (RunState.QUEUED, RunState.RUNNING):
        raise HTTPException(status_code=409, detail=f"run is {state.value}, result not ready yet")
    if state == RunState.CANCELLED:
        raise HTTPException(status_code=409, detail="run was cancelled, no result")
    if state == RunState.EXECUTION_ERROR:
        raise HTTPException(
            status_code=422,
            detail=f"run failed to execute (not a performance result): {run_record.error_message}",
        )

    result_record = repository.get_result(db, run_id)
    if result_record is None:
        # COMPLETED runs must always have a result; this indicates a bug in
        # run_service's completion path, not a client error.
        raise HTTPException(status_code=500, detail="run completed but no result was recorded")

    result = repository.result_record_to_schema(result_record)

    # --- Additive result-model enrichment (endpoint mix + per-endpoint
    # evidence phase). Purely assembled from data already persisted/
    # produced elsewhere -- no new computation, no LLM, no speculation. ---
    plan_record = repository.get_plan(db, run_record.plan_id)
    plan = repository.load_plan_model(plan_record) if plan_record is not None else None

    artifact_dir = Path(run_record.artifact_dir)

    def _existing_path(filename: str) -> Optional[str]:
        candidate = artifact_dir / filename
        return str(candidate) if candidate.exists() else None

    artifacts = ArtifactRefs(
        script_path=_existing_path("script.js"),
        results_json_path=_existing_path("results.json"),
        stdout_log_path=_existing_path("stdout.log"),
        stderr_log_path=_existing_path("stderr.log"),
    )

    return result.model_copy(
        update={
            "target_base_url": run_record.target_base_url,
            "plan": plan,
            "artifacts": artifacts,
        }
    )
