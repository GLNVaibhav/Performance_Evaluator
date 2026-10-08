"""Machine-readable experiment manifest (Phase 11).

One manifest per run answers "what EXACTLY was executed here?": the plan
(verbatim), the target, thresholds, endpoint weights, execution mode,
build/commit metadata, timestamps, correlation id, the bridge identifiers,
result provenance (an immutable REFERENCE to the stored result — the full
result is never duplicated), artifact file names, and the policy/tool
versions in force.

Served at GET /api/v1/runs/{run_id}/manifest — read-only, additive, and
assembled fresh from already-persisted records (the one source of truth),
never persisted separately. Nothing here recomputes or reinterprets a
result; an unknown identifier is surfaced as UNKNOWN, never guessed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from app.policies import ALL_POLICY_VERSIONS
from app.schemas.test_result import TestResult
from app.storage.models import TestPlanRecord, TestRunRecord

MANIFEST_SCHEMA_VERSION = "perforso.experiment-manifest.v1"

# Artifact filenames the engine writes into each run's isolated directory
# (app/services/k6_engine/k6_runner.py). Names only — never paths.
_ARTIFACT_FILE_NAMES = ["script.js", "results.json", "stdout.log", "stderr.log"]


class ResultProvenance(BaseModel):
    """An immutable pointer to the stored result — NOT a copy of it. The
    result itself stays at GET /runs/{id}/result; the manifest references
    it so another engineer can fetch exactly what this run produced."""

    status: str  # completed | execution_error | running | queued | ...
    result_endpoint: Optional[str] = None  # e.g. "/api/v1/runs/<id>/result"
    threshold_status: Optional[str] = None
    artifact_dir_name: str  # directory NAME inside the artifact root, not a path
    artifact_files: list[str]


class ExperimentManifest(BaseModel):
    schema_version: str = MANIFEST_SCHEMA_VERSION
    run_id: str
    correlation_id: Optional[str] = None
    submitted_by: Optional[str] = None
    target_base_url: str
    plan: dict  # the verbatim persisted plan (source of truth for what ran)
    execution_mode: str  # "LIVE_K6" — this backend has exactly one real mode
    thresholds: dict
    endpoint_weights: Optional[dict[str, float]] = None
    build_metadata: dict[str, str]
    created_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    policies: dict[str, str]  # version identities in force at creation time
    result: ResultProvenance


def build_experiment_manifest(
    run: TestRunRecord,
    plan_record: TestPlanRecord,
    result: Optional[TestResult],
    correlation_id: Optional[str],
    submitted_by: Optional[str],
) -> ExperimentManifest:
    import json

    plan = json.loads(plan_record.plan_json)

    from app.schemas.enums import RunState

    state = run.state
    has_result = result is not None and state == RunState.COMPLETED.value

    from pathlib import PurePosixPath

    artifact_dir_name = PurePosixPath(run.artifact_dir.replace("\\\\", "/")).name or "UNKNOWN"

    return ExperimentManifest(
        run_id=run.id,
        correlation_id=correlation_id or _correlation_from_assumptions(plan),
        submitted_by=submitted_by,
        target_base_url=run.target_base_url,
        plan=plan,
        execution_mode="LIVE_K6",
        thresholds=plan.get("thresholds", {}),
        endpoint_weights=plan.get("endpoint_weights"),
        build_metadata={
            "build_id": run.build_id,
            "git_commit": run.git_commit,
            "application_version": run.application_version,
            "environment": run.environment,
            "deployment_id": run.deployment_id,
        },
        created_at=run.created_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
        policies=ALL_POLICY_VERSIONS,
        result=ResultProvenance(
            status=state,
            result_endpoint=f"/api/v1/runs/{run.id}/result" if has_result else None,
            threshold_status=result.threshold_status if has_result else None,
            artifact_dir_name=artifact_dir_name,
            artifact_files=_ARTIFACT_FILE_NAMES if state in (RunState.COMPLETED.value, RunState.EXECUTION_ERROR.value) else [],
        ),
    )


def _correlation_from_assumptions(plan: dict) -> Optional[str]:
    """The correlation id rides in the plan's assumptions (the frozen
    central contract — see app/schemas/run.py's echo validator); recover it
    for manifests of runs created before it was returned by the API."""
    for entry in plan.get("assumptions", []):
        if isinstance(entry, str) and entry.startswith("correlation_id: "):
            value = entry.split("correlation_id: ", 1)[1].strip()
            return value or None
    return None
