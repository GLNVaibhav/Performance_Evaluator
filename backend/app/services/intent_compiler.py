"""IntentToTestPlanCompiler: the deterministic bridge between
UniversalPerformanceIntent (what the AI layer produced from natural
language) and TestPlan (the existing, frozen execution contract).

This module contains NO AI calls, no free-form generation, and no
execution. It is a pure function of its input: the same intent always
compiles to the same result (see tests/test_intent_compiler.py::
test_compilation_is_deterministic). It never generates k6 JavaScript,
never invokes a subprocess, and never bypasses
app/services/workload_limits.py -- every compiled TestPlan is run through
the same `validate_workload_limits` gate that `run_service.create_run`
uses, so an intent has no way to reach the engine with a workload the
structured-TestPlan path itself would reject.

See backend/docs/ai_intent_architecture.md for the full architecture and
the rationale behind each rule below.
"""

import re
from typing import List, Optional, Tuple

from app.schemas.enums import IntentStatus, ObjectiveType, TestType
from app.schemas.intent import (
    ClarificationItem,
    IntentCompilationResponse,
    UniversalPerformanceIntent,
)
from app.schemas.test_plan import BoundarySearchPlan, FixedLoadPlan, TestPlan, Thresholds
from app.services.workload_limits import WorkloadLimitExceededError, validate_workload_limits

# --- Deterministic defaults -------------------------------------------------
# Applied ONLY when the corresponding field is absent from the intent. Never
# used to paper over a genuinely required-but-missing field (see
# NEEDS_CLARIFICATION rules below) -- these are conveniences for optional
# fields the intent contract explicitly allows to be omitted, not guesses at
# execution-critical parameters like concurrency or duration.
DEFAULT_P95_LATENCY_MS = 1000
DEFAULT_ERROR_RATE = 0.05

# STRESS compiles to a single BoundarySearchPlan experiment (see
# performance_engine_interface.md: "one target VU level per experiment").
# The intent contract has no separate ramp/hold fields, so:
#   - if `duration` is given, it is used as hold_duration and ramp_duration
#     always takes this fixed default;
#   - if `duration` is absent, hold_duration also takes its fixed default.
# Both substitutions are recorded in the compiled plan's `assumptions`.
DEFAULT_STRESS_RAMP_DURATION = "10s"
DEFAULT_STRESS_HOLD_DURATION = "20s"

_ENDPOINT_PATTERN = re.compile(r"^/[A-Za-z0-9_\-./{}]*$")


class RejectionCode:
    UNSUPPORTED_SCHEDULE = "unsupported_schedule"
    UNSUPPORTED_BUSINESS_FLOW = "unsupported_business_flow"
    INVALID_ENDPOINT = "invalid_endpoint"
    WORKLOAD_LIMIT_EXCEEDED = "workload_limit_exceeded"


def _invalid(intent: UniversalPerformanceIntent, code: str, reason: str) -> IntentCompilationResponse:
    return IntentCompilationResponse(
        status=IntentStatus.INVALID,
        intent=intent,
        rejection_code=code,
        rejection_reason=reason,
    )


def _needs_clarification(
    intent: UniversalPerformanceIntent, items: List[ClarificationItem]
) -> IntentCompilationResponse:
    return IntentCompilationResponse(
        status=IntentStatus.NEEDS_CLARIFICATION,
        intent=intent,
        clarifications_needed=items,
    )


def _validate_endpoints(endpoints: List[str]) -> Optional[str]:
    """Returns the first structurally invalid endpoint, or None if all are
    valid. Structural only (leading slash, no scheme, no whitespace) -- not
    a check against the target's actual OpenAPI surface."""
    for endpoint in endpoints:
        if not isinstance(endpoint, str) or not endpoint.strip():
            return endpoint
        if not _ENDPOINT_PATTERN.match(endpoint):
            return endpoint
    return None


def _resolve_target_vus(
    intent: UniversalPerformanceIntent, test_type: TestType
) -> Tuple[Optional[int], List[ClarificationItem], List[str]]:
    """Returns (target_vus, clarifications, assumptions). Never falls back
    from one load_profile field to the other -- baseline/soak need
    concurrent_users (typical load), stress needs peak_users (the ceiling to
    probe), and asking for the wrong one is treated as missing, not
    substitutable."""
    assumptions: List[str] = []
    profile = intent.load_profile

    if test_type == TestType.stress:
        if profile.peak_users is not None:
            if profile.concurrent_users is not None:
                assumptions.append(
                    "load_profile.concurrent_users was provided but ignored: "
                    "stress test_type uses load_profile.peak_users"
                )
            return profile.peak_users, [], assumptions
        return None, [
            ClarificationItem(
                field="load_profile.peak_users",
                question="What peak/maximum concurrent user count should the stress test target?",
            )
        ], assumptions

    # baseline / soak
    if profile.concurrent_users is not None:
        if profile.peak_users is not None:
            assumptions.append(
                "load_profile.peak_users was provided but ignored: "
                f"{test_type.value} test_type uses load_profile.concurrent_users"
            )
        return profile.concurrent_users, [], assumptions
    return None, [
        ClarificationItem(
            field="load_profile.concurrent_users",
            question="How many concurrent users represent the typical/expected load to simulate?",
        )
    ], assumptions


def compile_intent(intent: UniversalPerformanceIntent) -> IntentCompilationResponse:
    """Deterministically compiles a UniversalPerformanceIntent into an
    IntentCompilationResponse. Never raises for a malformed-but-structurally-
    valid intent -- ambiguity and unsupported combinations are expressed as
    NEEDS_CLARIFICATION / INVALID results, not exceptions. A genuinely
    unexpected internal error (e.g. TestPlan construction failing after
    passing every check below) is a bug in this compiler, not caller input,
    and is allowed to propagate.
    """

    # --- Hard-unsupported combinations: no amount of clarification fixes
    # these for MVP, so they are INVALID, not NEEDS_CLARIFICATION. ---------
    if intent.schedule is not None:
        return _invalid(
            intent,
            RejectionCode.UNSUPPORTED_SCHEDULE,
            "scheduling intent is not supported yet -- compile and run intents synchronously",
        )

    if intent.business_flow is not None:
        return _invalid(
            intent,
            RejectionCode.UNSUPPORTED_BUSINESS_FLOW,
            "business-flow resolution is not supported yet -- provide target_scope.endpoints "
            "with the concrete endpoint(s) to test instead of business_flow",
        )

    # --- Missing/ambiguous required fields: these ARE resolvable by asking
    # the user, so collect every one before returning (a UI can show them
    # all at once instead of a round trip per field). --------------------
    clarifications: List[ClarificationItem] = []

    if intent.test_type is None:
        clarifications.append(
            ClarificationItem(field="test_type", question="Is this a baseline, stress, or soak test?")
        )

    endpoints = intent.target_scope.endpoints
    if not endpoints:
        clarifications.append(
            ClarificationItem(
                field="target_scope.endpoints",
                question="Which endpoint(s) should be tested?",
            )
        )

    vu_assumptions: List[str] = []
    target_vus: Optional[int] = None
    if intent.test_type is not None:
        target_vus, vu_clarifications, vu_assumptions = _resolve_target_vus(intent, intent.test_type)
        clarifications.extend(vu_clarifications)

    if intent.test_type in (TestType.baseline, TestType.soak) and intent.duration is None:
        clarifications.append(
            ClarificationItem(
                field="duration",
                question="How long should the test run (e.g. '30s', '5m')?",
            )
        )

    # AI-supplied clarifications are respected, never silently dropped --
    # the backend re-derives its own regardless of what the AI claims (a
    # READY claim from upstream is never trusted blindly), but anything the
    # AI already flagged is merged in too.
    seen_fields = {c.field for c in clarifications}
    for item in intent.clarifications_needed:
        if item.field not in seen_fields:
            clarifications.append(item)
            seen_fields.add(item.field)

    if clarifications:
        return _needs_clarification(intent, clarifications)

    # --- From here, test_type, endpoints, and target_vus are all present. ---
    assert intent.test_type is not None and endpoints and target_vus is not None

    invalid_endpoint = _validate_endpoints(endpoints)
    if invalid_endpoint is not None:
        return _invalid(
            intent,
            RejectionCode.INVALID_ENDPOINT,
            f"endpoint {invalid_endpoint!r} is not a structurally valid path "
            "(must start with '/', no scheme, no whitespace)",
        )

    assumptions = list(vu_assumptions)
    sc = intent.success_criteria
    if sc.p95_latency_ms is None:
        assumptions.append(f"success_criteria.p95_latency_ms defaulted to {DEFAULT_P95_LATENCY_MS}ms")
    if sc.error_rate is None:
        assumptions.append(f"success_criteria.error_rate defaulted to {DEFAULT_ERROR_RATE}")
    thresholds = Thresholds(
        p95_latency_ms=sc.p95_latency_ms if sc.p95_latency_ms is not None else DEFAULT_P95_LATENCY_MS,
        error_rate=sc.error_rate if sc.error_rate is not None else DEFAULT_ERROR_RATE,
    )

    plan: TestPlan
    if intent.test_type == TestType.stress:
        if intent.duration is not None:
            hold_duration = intent.duration
        else:
            hold_duration = DEFAULT_STRESS_HOLD_DURATION
            assumptions.append(f"hold_duration defaulted to {DEFAULT_STRESS_HOLD_DURATION}")
        assumptions.append(
            f"ramp_duration set to fixed default {DEFAULT_STRESS_RAMP_DURATION} "
            "(the intent contract has no separate ramp field)"
        )
        plan = BoundarySearchPlan(
            objective_type=ObjectiveType.boundary_search,
            test_type=intent.test_type,
            target_vus=target_vus,
            ramp_duration=DEFAULT_STRESS_RAMP_DURATION,
            hold_duration=hold_duration,
            thresholds=thresholds,
            selected_endpoints=endpoints,
            assumptions=assumptions,
        )
    else:  # baseline / soak
        assert intent.duration is not None
        plan = FixedLoadPlan(
            objective_type=ObjectiveType.fixed_load,
            test_type=intent.test_type,
            target_vus=target_vus,
            duration=intent.duration,
            thresholds=thresholds,
            selected_endpoints=endpoints,
            assumptions=assumptions,
        )

    try:
        validate_workload_limits(plan)
    except WorkloadLimitExceededError as exc:
        return _invalid(intent, RejectionCode.WORKLOAD_LIMIT_EXCEEDED, str(exc))

    return IntentCompilationResponse(status=IntentStatus.READY, intent=intent, test_plan=plan)
