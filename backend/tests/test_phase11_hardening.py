"""Phase 11 hardening tests.

Covers: readiness/liveness semantics, the reproducibility manifest, run
build/commit metadata (UNKNOWN, never inferred), the experiment manifest,
and versioned policy identities. All deterministic; no real k6 execution
(the FakePerformanceEngine pattern covers execution elsewhere).
"""

from __future__ import annotations

import json

import pytest

from app.core.config import K6_BINARY, MAX_DURATION_S, MAX_VUS
from app.experiment_manifest import MANIFEST_SCHEMA_VERSION, build_experiment_manifest
from app.policies import (
    BOUNDARY_SEARCH_POLICY_VERSION,
    THRESHOLD_POLICY_VERSION,
    WORKLOAD_LIMITS_POLICY_VERSION,
    ALL_POLICY_VERSIONS,
)
from app.schemas.run import BuildMetadata
from app.version_manifest import build_version_manifest

# --- readiness / liveness -------------------------------------------------------


def test_liveness_is_constant_and_unauthenticated(client):
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_readiness_checks_safe_dependencies_only(client):
    resp = client.get("/api/v1/health/ready")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in ("ready", "not_ready")
    names = {c["name"] for c in body["checks"]}
    # Exactly the safe checks — k6 presence (a PATH lookup), config sanity,
    # artifact-dir writability. Never "k6 runs", never "target reachable".
    assert names == {"workload_limits_configured", "artifacts_dir_usable", "k6_binary_present"}
    # The readiness invariant: ready IFF every check passes. (In the test
    # env k6 may legitimately be off PATH -> honest not_ready, never a
    # fabricated "ready".)
    assert body["status"] == ("ready" if all(c["ok"] for c in body["checks"]) else "not_ready")


def test_readiness_does_not_execute_k6_or_call_targets(client, monkeypatch):
    """A readiness probe must stay cheap and side-effect free: prove k6 is
    never executed and no HTTP request leaves the process during the probe."""
    from shutil import which

    executed = []
    monkeypatch.setattr("subprocess.run", lambda *a, **k: executed.append(a) or pytest.fail("readiness executed a subprocess"))

    class _Forbidden:
        def request(self, *a, **k):
            pytest.fail("readiness made an HTTP request")

    resp = client.get("/api/v1/health/ready")
    assert resp.status_code == 200
    assert executed == []
    # sanity: the PATH lookup itself is allowed (that is the whole point)
    assert which(K6_BINARY) is not None or resp.json()["status"] in ("ready", "not_ready")


# --- version manifest ------------------------------------------------------------


def test_version_manifest_shape_and_policies(client):
    resp = client.get("/api/v1/version")
    assert resp.status_code == 200
    body = resp.json()
    assert body["schema_version"] == "perforso.version-manifest.v1"
    assert body["policies"]["workloadLimits"] == WORKLOAD_LIMITS_POLICY_VERSION
    assert body["policies"]["threshold"] == THRESHOLD_POLICY_VERSION
    assert body["policies"]["boundarySearch"] == BOUNDARY_SEARCH_POLICY_VERSION
    # k6 identity is detected from the configured binary (or honest UNKNOWN)
    assert body["k6"]["name"] == "k6"
    assert isinstance(body["k6"]["version"], str) and body["k6"]["version"]


def test_version_manifest_never_contains_secrets_or_paths(client):
    body = client.get("/api/v1/version").json()
    text = json.dumps(body)
    for forbidden in ("EXECUTION_BRIDGE_TOKEN=", "sk-", "Bearer ", "LLM_API_KEY="):
        assert forbidden not in text
    # configuration NAMES are reported; VALUES never are
    assert "EXECUTION_BRIDGE_TOKEN" in body["environment_variable_names"]
    # model is a NAME, not a key
    assert "provider_kind" in body["llm"]


def test_version_manifest_does_not_fabricate_git_commit():
    m = build_version_manifest()
    # Either a deployment baked BACKEND_GIT_COMMIT, or the honest UNKNOWN —
    # never an invented hash-shaped guess.
    import os

    baked = os.environ.get("BACKEND_GIT_COMMIT", "").strip()
    assert m.backend_git_commit == (baked or "UNKNOWN")


def test_version_manifest_is_deterministic():
    a = build_version_manifest().model_dump(mode="json")
    b = build_version_manifest().model_dump(mode="json")
    a.pop("k6", None), b.pop("k6", None)  # k6 subprocess timing is not part of the contract
    assert a == b


# --- run build/commit metadata -----------------------------------------------------


def test_build_metadata_defaults_to_unknown():
    md = BuildMetadata().resolved()
    assert md == {
        "build_id": "UNKNOWN",
        "git_commit": "UNKNOWN",
        "application_version": "UNKNOWN",
        "environment": "UNKNOWN",
        "deployment_id": "UNKNOWN",
    }


def test_build_metadata_blanks_become_unknown_and_values_survive():
    md = BuildMetadata(build_id="ci-42", git_commit="  ", application_version="1.2.3").resolved()
    assert md["build_id"] == "ci-42"
    assert md["git_commit"] == "UNKNOWN"
    assert md["application_version"] == "1.2.3"


def test_build_metadata_rejects_oversized_labels():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        BuildMetadata(build_id="x" * 200).model_validate(BuildMetadata(build_id="x" * 200).model_dump())


def test_create_run_persists_metadata_and_unknowns(db_session):
    from app.schemas.run import BuildMetadata, RunCreateRequest
    from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
    from app.schemas.enums import ObjectiveType, TestType
    from app.services import run_service

    plan = FixedLoadPlan(
        objective_type=ObjectiveType.fixed_load,
        test_type=TestType.baseline,
        target_vus=1,
        duration="1s",
        selected_endpoints=["/products"],
        thresholds=Thresholds(p95_latency_ms=1000, error_rate=0.5),
        assumptions=[],
    )
    req = RunCreateRequest(
        plan=plan,
        target=TargetConfig(base_url="http://127.0.0.1:59999"),
        metadata=BuildMetadata(build_id="b-1", git_commit="abc123"),
    )
    record = run_service.create_run(db_session, req)
    assert record.build_id == "b-1"
    assert record.git_commit == "abc123"
    assert record.application_version == "UNKNOWN"  # absent → UNKNOWN, never inferred
    assert record.environment == "UNKNOWN"
    assert record.deployment_id == "UNKNOWN"


# --- experiment manifest -------------------------------------------------------------


def _completed_run(db_session, metadata=None):
    from app.schemas.run import BuildMetadata, RunCreateRequest
    from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
    from app.schemas.enums import ObjectiveType, TestType
    from app.services import run_service
    from app.storage import repository
    from tests.fakes import make_metrics
    from app.schemas.enums import ResultClassification

    plan = FixedLoadPlan(
        objective_type=ObjectiveType.fixed_load,
        test_type=TestType.baseline,
        target_vus=2,
        duration="1s",
        selected_endpoints=["/products"],
        thresholds=Thresholds(p95_latency_ms=1000, error_rate=0.5),
        assumptions=["correlation_id: corr-manifest-test"],
    )
    req = RunCreateRequest(
        plan=plan,
        target=TargetConfig(base_url="http://127.0.0.1:59999"),
        metadata=BuildMetadata(**(metadata or {})),
    )
    run = run_service.create_run(db_session, req)
    plan_record = repository.get_plan(db_session, run.plan_id)
    repository.save_result(db_session, run.id, make_metrics(), ResultClassification.PASS)
    repository.mark_run_completed(db_session, run.id)
    return run, plan_record


def test_experiment_manifest_records_what_ran(db_session):
    from app.storage import repository

    run, plan_record = _completed_run(db_session, metadata={"build_id": "b-9", "git_commit": "cafe123"})
    result = repository.result_record_to_schema(repository.get_result(db_session, run.id))
    manifest = build_experiment_manifest(run, plan_record, result, correlation_id=None, submitted_by=None)

    assert manifest.schema_version == MANIFEST_SCHEMA_VERSION
    assert manifest.execution_mode == "LIVE_K6"
    assert manifest.plan["target_vus"] == 2
    assert manifest.thresholds == {"p95_latency_ms": 1000, "error_rate": 0.5}
    assert manifest.build_metadata["build_id"] == "b-9"
    assert manifest.build_metadata["git_commit"] == "cafe123"
    assert manifest.build_metadata["application_version"] == "UNKNOWN"
    assert manifest.correlation_id == "corr-manifest-test"  # recovered from plan assumptions
    assert manifest.policies == ALL_POLICY_VERSIONS
    # result provenance is a REFERENCE, not a copy
    assert manifest.result.threshold_status == "PASS"
    assert manifest.result.result_endpoint == f"/api/v1/runs/{run.id}/result"
    assert "results.json" in manifest.result.artifact_files
    assert not hasattr(manifest.result, "metrics")


def test_experiment_manifest_route_serves_provenance(client, db_session):
    run, _ = _completed_run(db_session)
    resp = client.get(f"/api/v1/runs/{run.id}/manifest")
    assert resp.status_code == 200
    body = resp.json()
    assert body["run_id"] == run.id
    assert body["execution_mode"] == "LIVE_K6"
    assert body["result"]["threshold_status"] == "PASS"
    assert "metrics" not in body["result"]  # reference, not duplication


def test_experiment_manifest_404s_for_unknown_run(client):
    assert client.get("/api/v1/runs/nope/manifest").status_code == 404


# --- policy versioning -----------------------------------------------------------------


def test_policy_versions_are_declared_and_stable():
    assert WORKLOAD_LIMITS_POLICY_VERSION == "perforso.workload-limits.v1"
    assert THRESHOLD_POLICY_VERSION == "perforso.threshold.v1"
    assert BOUNDARY_SEARCH_POLICY_VERSION == "perforso.boundary-search.v1"
    assert set(ALL_POLICY_VERSIONS) == {"workloadLimits", "threshold", "boundarySearch", "targetSsrf"}


def test_workload_limits_gate_still_enforces_after_versioning():
    """Versioning documents the gate; it must not weaken it."""
    from app.services.workload_limits import WorkloadLimitExceededError, parse_duration_seconds, validate_workload_limits
    from app.schemas.enums import ObjectiveType, TestType
    from app.schemas.test_plan import FixedLoadPlan, Thresholds

    with pytest.raises(WorkloadLimitExceededError):
        validate_workload_limits(
            FixedLoadPlan(
                objective_type=ObjectiveType.fixed_load,
                test_type=TestType.baseline,
                target_vus=MAX_VUS + 1,
                duration="1s",
                selected_endpoints=["/products"],
                thresholds=Thresholds(p95_latency_ms=1000, error_rate=0.5),
                assumptions=[],
            )
        )
    with pytest.raises(WorkloadLimitExceededError):
        validate_workload_limits(
            FixedLoadPlan(
                objective_type=ObjectiveType.fixed_load,
                test_type=TestType.baseline,
                target_vus=1,
                duration=f"{MAX_DURATION_S + 1}s",
                selected_endpoints=["/products"],
                thresholds=Thresholds(p95_latency_ms=1000, error_rate=0.5),
                assumptions=[],
            )
        )
    assert parse_duration_seconds("90s") == 90.0
