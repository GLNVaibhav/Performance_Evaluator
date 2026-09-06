from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas.enums import RunState
from app.schemas.run import RunCreateRequest, RunCreateResponse, RunStatusResponse
from app.schemas.test_result import (
    AIAnalysis,
    ArtifactRefs,
    TestResult,
    build_failure_localization,
    build_statistics,
)
from app.services import run_service
from app.services.ai_analyzer import AIAnalysisInput
from app.services.ai_analyzer_provider import get_ai_analyzer
from app.services.engine_provider import get_performance_engine
from app.services.target_url_safety import TargetURLSafetyError
from app.services.target_validation import TargetValidationError
from app.services.workload_limits import WorkloadLimitExceededError
from app.storage import repository

router = APIRouter(prefix="/runs", tags=["runs"])


class AIAnalysisResponse(BaseModel):
    """Route-local response model (same pattern as
    app/api/routes_intents.py's KnownEndpointsResponse/
    WorkloadLimitsResponse) -- explicit `available`/`reason` rather than a
    bare nullable body, so a client can tell "analysis absent" from
    "analysis present but empty" without inspecting JSON null vs. missing
    keys."""

    available: bool
    analysis: Optional[AIAnalysis] = None
    reason: Optional[str] = None


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
    except TargetURLSafetyError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except TargetValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    background_tasks.add_task(run_service.execute_run, run_record.id, get_performance_engine())
    return RunCreateResponse(run_id=run_record.id, status=RunState(run_record.state))


@router.get("", response_model=List[RunStatusResponse])
def list_runs(limit: int = 20, db: Session = Depends(get_db)) -> List[RunStatusResponse]:
    """Most-recent-first run history -- read-only, additive. Does not
    touch run_service, the execution lifecycle, or any protected
    boundary; reuses the exact same RunStatusResponse shape GET
    /runs/{run_id} already returns."""
    limit = max(1, min(limit, 100))
    records = repository.list_runs(db, limit=limit)
    return [
        RunStatusResponse(
            run_id=r.id,
            status=RunState(r.state),
            created_at=r.created_at,
            started_at=r.started_at,
            finished_at=r.finished_at,
            error_message=r.error_message,
        )
        for r in records
    ]


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
            # Additive (Session 5): assembled fresh from the same
            # already-persisted result.metrics -- see
            # app/schemas/test_result.py::build_statistics()'s docstring
            # for why this is not a second source of truth.
            "statistics": build_statistics(result.metrics),
            # Additive (final session): same "assemble, don't recompute"
            # pattern -- cheap, deterministic, no LLM.
            "failure_localization": build_failure_localization(
                result.metrics, result.threshold_status, result.threshold_violations, plan
            ),
        }
    )


@router.post("/{run_id}/analyze", response_model=AIAnalysisResponse)
def analyze_run(run_id: str, db: Session = Depends(get_db)) -> AIAnalysisResponse:
    """Separate, EXPLICIT AI-analysis step -- mirrors the existing
    POST /intents/interpret boundary: never auto-triggered by GET
    .../result, never required for the deterministic result to be
    complete. This is the ONLY place `AIAnalysis` is ever returned --
    GET /runs/{id}/result carries no ai_analysis field at all, precisely
    so there is no half-persisted field that could misleadingly suggest
    analysis might "show up later" on a plain result fetch (see
    app/schemas/test_result.py::TestResult's docstring). Performs no new
    k6 execution and no new measurement --
    reads only already-persisted data, builds the same
    Statistics/FailureLocalization a GET .../result call would, and hands
    them to the analyzer. If the analyzer is unavailable or its response
    is malformed, this returns `available=False` -- a 200, never a 500 --
    since "no AI analysis" is an ordinary, fully-supported outcome, not an
    error."""
    run_record = repository.get_run(db, run_id)
    if run_record is None:
        raise HTTPException(status_code=404, detail="run not found")

    state = RunState(run_record.state)
    if state != RunState.COMPLETED:
        raise HTTPException(status_code=409, detail=f"run is {state.value}, no result to analyze yet")

    result_record = repository.get_result(db, run_id)
    if result_record is None:
        raise HTTPException(status_code=500, detail="run completed but no result was recorded")

    result = repository.result_record_to_schema(result_record)
    plan_record = repository.get_plan(db, run_record.plan_id)
    plan = repository.load_plan_model(plan_record) if plan_record is not None else None

    evidence = AIAnalysisInput(
        run_id=run_id,
        target_base_url=run_record.target_base_url,
        plan=plan,
        threshold_status=result.threshold_status,
        statistics=build_statistics(result.metrics),
        failure_localization=build_failure_localization(
            result.metrics, result.threshold_status, result.threshold_violations, plan
        ),
    )

    analysis = get_ai_analyzer().analyze(evidence)
    if analysis is None:
        return AIAnalysisResponse(
            available=False, reason="AI analysis unavailable (provider unreachable or response invalid)"
        )
    return AIAnalysisResponse(available=True, analysis=analysis)
