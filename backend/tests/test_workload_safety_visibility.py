"""Session 3: workload-safety visibility -- GET /intents/workload-limits
(new, read-only) and the enriched, advisory WORKLOAD_LIMIT_EXCEEDED
rejection message from app/services/intent_compiler.py. The actual
enforcement (validate_workload_limits, reject-not-silently-adjust) is
UNCHANGED -- these tests prove the existing policy is now more actionable,
not that the policy itself changed. See tests/test_intent_compiler.py's
pre-existing test_excessive_target_vus_is_rejected /
test_excessive_duration_is_rejected, which still pass unmodified.
"""
from app.core.config import MAX_DURATION_S, MAX_VUS
from app.schemas.enums import IntentStatus
from app.schemas.intent import UniversalPerformanceIntent
from app.services.intent_compiler import RejectionCode, compile_intent


def _baseline_intent(**overrides):
    payload = {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 50},
        "duration": "30s",
        "target_scope": {"endpoints": ["/products"]},
        "success_criteria": {"p95_latency_ms": 500, "error_rate": 0.01},
    }
    payload.update(overrides)
    return UniversalPerformanceIntent.model_validate(payload)


# --- Valid workload remains completely unchanged ----------------------------


def test_valid_workload_compiles_ready_unaffected():
    result = compile_intent(_baseline_intent())
    assert result.status == IntentStatus.READY
    assert result.test_plan.target_vus == 50


# --- Excessive VUs: still rejected, never silently altered ------------------


def test_excessive_vus_is_still_rejected_never_silently_capped():
    intent = _baseline_intent(load_profile={"concurrent_users": 999_999})
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.WORKLOAD_LIMIT_EXCEEDED
    # Never silently altered: no TestPlan exists to have been "adjusted".
    assert result.test_plan is None


def test_excessive_vus_rejection_surfaces_a_concrete_safe_alternative():
    intent = _baseline_intent(load_profile={"concurrent_users": 999_999})
    result = compile_intent(intent)

    reason = result.rejection_reason
    assert "Requested:" in reason
    assert "999999" in reason
    assert "Safe configured maximum:" in reason
    assert str(MAX_VUS) in reason
    assert "advisory only" in reason
    assert "nothing was executed" in reason


def test_excessive_duration_rejection_surfaces_a_concrete_safe_alternative():
    intent = _baseline_intent(duration="500s")
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.WORKLOAD_LIMIT_EXCEEDED
    reason = result.rejection_reason
    assert "Requested:" in reason
    assert "500s" in reason
    assert "Safe configured maximum:" in reason
    assert f"{MAX_DURATION_S}s" in reason


def test_excessive_stress_workload_rejection_accounts_for_ramp_plus_hold():
    """boundary_search plans split MAX_DURATION_S across ramp+hold -- the
    suggested safe hold_duration must leave room for the (fixed) ramp
    duration, never suggest a combined total that would itself still
    exceed MAX_DURATION_S."""
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "stress",
            "load_profile": {"peak_users": 999_999},
            "duration": "500s",
            "target_scope": {"endpoints": ["/checkout"]},
        }
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    reason = result.rejection_reason
    assert "ramp" in reason and "hold" in reason
    assert "Safe configured maximum:" in reason


# --- GET /intents/workload-limits -------------------------------------------


def test_workload_limits_endpoint_reports_the_real_configured_values(client):
    resp = client.get("/api/v1/intents/workload-limits")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"max_vus": MAX_VUS, "max_duration_s": MAX_DURATION_S}


def test_workload_limits_endpoint_is_read_only_creates_no_run(client, db_session):
    from app.storage import repository

    runs_before = db_session.query(repository.TestRunRecord).count()
    client.get("/api/v1/intents/workload-limits")
    runs_after = db_session.query(repository.TestRunRecord).count()
    assert runs_after == runs_before
