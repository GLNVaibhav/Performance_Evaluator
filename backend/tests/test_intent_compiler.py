"""Unit tests for app/services/intent_compiler.py. These call compile_intent
directly (no HTTP, no DB) since compilation is a pure function of its input.
See tests/test_intent_routes.py for the HTTP-level / cross-cutting tests
(backward compatibility, engine isolation, schema-level validation errors).
"""

from app.schemas.enums import IntentStatus, TestType
from app.schemas.intent import UniversalPerformanceIntent
from app.schemas.test_plan import BoundarySearchPlan, FixedLoadPlan
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


# 1. Valid baseline intent -> TestPlan
def test_baseline_intent_compiles_to_fixed_load_plan():
    result = compile_intent(_baseline_intent())

    assert result.status == IntentStatus.READY
    assert isinstance(result.test_plan, FixedLoadPlan)
    assert result.test_plan.test_type == TestType.baseline
    assert result.test_plan.target_vus == 50
    assert result.test_plan.duration == "30s"
    assert result.test_plan.selected_endpoints == ["/products"]
    assert result.test_plan.thresholds.p95_latency_ms == 500
    assert result.test_plan.thresholds.error_rate == 0.01


# 2. Valid stress intent -> TestPlan
def test_stress_intent_compiles_to_boundary_search_plan():
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "stress",
            "load_profile": {"peak_users": 500},
            "duration": "20s",
            "target_scope": {"endpoints": ["/checkout"]},
            "success_criteria": {"p95_latency_ms": 1000, "error_rate": 0.05},
        }
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.READY
    assert isinstance(result.test_plan, BoundarySearchPlan)
    assert result.test_plan.target_vus == 500
    assert result.test_plan.hold_duration == "20s"
    assert result.test_plan.ramp_duration == "10s"  # DEFAULT_STRESS_RAMP_DURATION


def test_stress_intent_without_duration_uses_default_hold_duration():
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "stress",
            "load_profile": {"peak_users": 500},
            "target_scope": {"endpoints": ["/checkout"]},
        }
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.READY
    assert result.test_plan.hold_duration == "20s"  # DEFAULT_STRESS_HOLD_DURATION
    assert result.test_plan.ramp_duration == "10s"


# 3. Valid soak intent -> supported result, honestly represented as fixed_load
def test_soak_intent_compiles_to_fixed_load_plan():
    intent = _baseline_intent(test_type="soak", duration="60s")
    result = compile_intent(intent)

    assert result.status == IntentStatus.READY
    assert isinstance(result.test_plan, FixedLoadPlan)
    assert result.test_plan.test_type == TestType.soak


# 4. Missing concurrency -> NEEDS_CLARIFICATION
def test_missing_concurrent_users_needs_clarification():
    intent = _baseline_intent(load_profile={})
    result = compile_intent(intent)

    assert result.status == IntentStatus.NEEDS_CLARIFICATION
    fields = {c.field for c in result.clarifications_needed}
    assert "load_profile.concurrent_users" in fields


# 5. Missing duration -> NEEDS_CLARIFICATION
def test_missing_duration_needs_clarification():
    intent = _baseline_intent(duration=None)
    result = compile_intent(intent)

    assert result.status == IntentStatus.NEEDS_CLARIFICATION
    fields = {c.field for c in result.clarifications_needed}
    assert "duration" in fields


# 6. Ambiguous target -> NEEDS_CLARIFICATION
def test_missing_target_endpoints_needs_clarification():
    intent = _baseline_intent(target_scope={})
    result = compile_intent(intent)

    assert result.status == IntentStatus.NEEDS_CLARIFICATION
    fields = {c.field for c in result.clarifications_needed}
    assert "target_scope.endpoints" in fields


def test_stress_missing_peak_users_does_not_fall_back_to_concurrent_users():
    """Stress needs peak_users specifically -- giving concurrent_users
    instead must not be silently treated as the same thing."""
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "stress",
            "load_profile": {"concurrent_users": 500},
            "duration": "20s",
            "target_scope": {"endpoints": ["/checkout"]},
        }
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.NEEDS_CLARIFICATION
    fields = {c.field for c in result.clarifications_needed}
    assert "load_profile.peak_users" in fields


def test_missing_test_type_needs_clarification():
    intent = _baseline_intent(test_type=None)
    result = compile_intent(intent)

    assert result.status == IntentStatus.NEEDS_CLARIFICATION
    fields = {c.field for c in result.clarifications_needed}
    assert "test_type" in fields


def test_multiple_missing_fields_reported_together():
    intent = UniversalPerformanceIntent.model_validate({"test_type": "baseline"})
    result = compile_intent(intent)

    assert result.status == IntentStatus.NEEDS_CLARIFICATION
    fields = {c.field for c in result.clarifications_needed}
    assert {"load_profile.concurrent_users", "target_scope.endpoints", "duration"} <= fields


def test_ai_supplied_clarifications_are_merged_in():
    intent = _baseline_intent(
        clarifications_needed=[{"field": "objective", "question": "What business goal does this serve?"}]
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.NEEDS_CLARIFICATION
    fields = {c.field for c in result.clarifications_needed}
    assert "objective" in fields


# 7. Unsafe VU count -> rejected
def test_excessive_target_vus_is_rejected():
    # conftest.py pins MAX_VUS=2000 for the test session; config.py reads env
    # at import time so setting it per-test would have no effect here.
    intent = _baseline_intent(load_profile={"concurrent_users": 999_999})
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.WORKLOAD_LIMIT_EXCEEDED


# 8. Duration above limits -> rejected
def test_excessive_duration_is_rejected():
    intent = _baseline_intent(duration="500s")
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.WORKLOAD_LIMIT_EXCEEDED


# 10. Unsupported business flow -> explicit failure
def test_business_flow_is_explicitly_unsupported():
    intent = _baseline_intent(business_flow=["browse_products", "checkout"])
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.UNSUPPORTED_BUSINESS_FLOW


def test_business_flow_structured_form_also_rejected():
    intent = _baseline_intent(business_flow={"name": "purchase_flow", "steps": ["browse", "checkout"]})
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.UNSUPPORTED_BUSINESS_FLOW


def test_schedule_is_explicitly_unsupported():
    intent = _baseline_intent(schedule={"cron": "0 0 * * *"})
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.UNSUPPORTED_SCHEDULE


def test_structurally_invalid_endpoint_is_rejected():
    intent = _baseline_intent(target_scope={"endpoints": ["https://evil.example.com/products"]})
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.INVALID_ENDPOINT


# 11. Ready intent -> deterministic TestPlan; defaults applied are recorded
def test_missing_success_criteria_gets_deterministic_defaults():
    intent = _baseline_intent(success_criteria={})
    result = compile_intent(intent)

    assert result.status == IntentStatus.READY
    assert result.test_plan.thresholds.p95_latency_ms == 1000
    assert result.test_plan.thresholds.error_rate == 0.05
    assert any("p95_latency_ms defaulted" in a for a in result.test_plan.assumptions)
    assert any("error_rate defaulted" in a for a in result.test_plan.assumptions)


# 15. Same intent always produces same TestPlan (determinism)
def test_compilation_is_deterministic():
    intent = _baseline_intent()
    result_a = compile_intent(_baseline_intent())
    result_b = compile_intent(_baseline_intent())

    assert result_a.status == result_b.status == IntentStatus.READY
    assert result_a.test_plan.model_dump() == result_b.test_plan.model_dump()
    # Sanity: not just comparing default-constructed objects to themselves.
    assert result_a.test_plan.model_dump() == compile_intent(intent).test_plan.model_dump()


# --- Endpoint traffic weights (Phase 0: intent -> TestPlan.endpoint_weights) --
#
# These prove the COMPLETE UniversalPerformanceIntent -> compile_intent() ->
# TestPlan contract, not just TestPlan's own validator (already covered by
# tests/test_endpoint_mix_schema.py) -- every case here goes in as intent
# JSON and comes out as (or is rejected before becoming) a compiled plan.


def test_intent_without_endpoint_weights_compiles_with_uniform_behaviour():
    """Omitting endpoint_weights entirely must be indistinguishable from
    before this field existed: the compiled plan's endpoint_weights is
    None, meaning uniform dispatch (see script_renderer.py)."""
    intent = _baseline_intent(target_scope={"endpoints": ["/products", "/checkout"]})
    result = compile_intent(intent)

    assert result.status == IntentStatus.READY
    assert result.test_plan.endpoint_weights is None


def test_intent_with_valid_endpoint_weights_compiles_and_matches_exactly():
    weights = {"/products": 60, "/search": 25, "/checkout": 15}
    intent = _baseline_intent(
        target_scope={"endpoints": ["/products", "/search", "/checkout"], "endpoint_weights": weights}
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.READY
    assert result.test_plan.endpoint_weights == weights


def test_intent_endpoint_weights_need_not_sum_to_100():
    """The intent layer imposes no normalization -- it passes weights
    through verbatim and TestPlan's own validator (which only requires
    positivity, not a particular sum) is the sole authority."""
    intent = _baseline_intent(
        target_scope={"endpoints": ["/products", "/search", "/checkout"], "endpoint_weights": {"/products": 6, "/search": 3, "/checkout": 1}}
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.READY
    assert result.test_plan.endpoint_weights == {"/products": 6, "/search": 3, "/checkout": 1}


def test_intent_with_negative_endpoint_weight_is_rejected():
    intent = _baseline_intent(
        target_scope={"endpoints": ["/products", "/checkout"], "endpoint_weights": {"/products": -1, "/checkout": 40}}
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.INVALID_ENDPOINT_WEIGHTS
    assert result.test_plan is None


def test_intent_with_zero_endpoint_weight_is_rejected():
    intent = _baseline_intent(
        target_scope={"endpoints": ["/products", "/checkout"], "endpoint_weights": {"/products": 0, "/checkout": 40}}
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.INVALID_ENDPOINT_WEIGHTS


def test_intent_missing_weight_for_a_selected_endpoint_is_rejected():
    """A malformed mapping that omits a selected endpoint must be rejected,
    never silently treated as "unweighted" -- that would be exactly the
    kind of hidden inference this compiler must never do."""
    intent = _baseline_intent(
        target_scope={"endpoints": ["/products", "/checkout"], "endpoint_weights": {"/products": 100}}
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.INVALID_ENDPOINT_WEIGHTS


def test_intent_weight_for_an_unselected_endpoint_is_rejected():
    intent = _baseline_intent(
        target_scope={
            "endpoints": ["/products", "/checkout"],
            "endpoint_weights": {"/products": 60, "/checkout": 30, "/search": 10},
        }
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.INVALID_ENDPOINT_WEIGHTS


def test_stress_intent_with_endpoint_weights_compiles_to_boundary_search_plan():
    """Both compiled plan variants support endpoint_weights (it lives on
    _PlanBase), so the intent-layer pass-through must work for stress too,
    not just baseline/soak."""
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "stress",
            "load_profile": {"peak_users": 500},
            "duration": "20s",
            "target_scope": {
                "endpoints": ["/products", "/checkout"],
                "endpoint_weights": {"/products": 70, "/checkout": 30},
            },
        }
    )
    result = compile_intent(intent)

    assert result.status == IntentStatus.READY
    assert isinstance(result.test_plan, BoundarySearchPlan)
    assert result.test_plan.endpoint_weights == {"/products": 70, "/checkout": 30}


def test_intent_endpoint_weights_do_not_affect_clarification_or_invalid_paths():
    """Existing NEEDS_CLARIFICATION / INVALID behaviour for unrelated
    problems is unchanged by this feature -- endpoint_weights being valid
    doesn't paper over a missing duration, and business_flow is still
    rejected outright regardless of endpoint_weights being present."""
    missing_duration = _baseline_intent(
        duration=None,
        target_scope={"endpoints": ["/products", "/checkout"], "endpoint_weights": {"/products": 60, "/checkout": 40}},
    )
    result = compile_intent(missing_duration)
    assert result.status == IntentStatus.NEEDS_CLARIFICATION

    with_business_flow = _baseline_intent(
        business_flow=["browse", "checkout"],
        target_scope={"endpoints": ["/products", "/checkout"], "endpoint_weights": {"/products": 60, "/checkout": 40}},
    )
    result = compile_intent(with_business_flow)
    assert result.status == IntentStatus.INVALID
    assert result.rejection_code == RejectionCode.UNSUPPORTED_BUSINESS_FLOW
