"""Target-aware pre-execution validation: does the compiled TestPlan's
selected_endpoints actually exist against THIS target's real OpenAPI
surface?

Deliberately separate from compile_intent() (app/services/intent_compiler.py),
which stays target-agnostic and side-effect-free -- checking a target's
real OpenAPI surface is inherently target-dependent and requires a network
call, which is exactly why it does not belong in compilation. This module
is the one new gate inserted at the one place a TestPlan and a real
TargetConfig first meet: run_service.create_run(), positioned the same way
workload_limits.validate_workload_limits() already is -- authoritative,
pre-persistence, so no plan/run row is created for a workload known in
advance to be incompatible with its target, and the incompatibility is
discovered before the run is even created (QUEUED), not merely before k6
runs (RealK6PerformanceEngine already avoided invoking the k6 subprocess
for this case -- see its _PRE_EXECUTION_ERRORS handling -- but a client
would previously only learn that by creating a run and polling it).

Reuses the EXISTING OpenAPI fetch/resolve mechanism verbatim
(app/services/k6_engine/openapi_loader.py, .../endpoint_resolver.py) -- no
duplicated parsing or resolution logic, and no new OpenAPI parser. This is
the exact same mechanism RealK6PerformanceEngine.execute() already calls;
this module calls it a second time, earlier, purely to fail fast with a
clear pre-persistence error instead of only discovering the same problem
after the run has already been created and background execution has
begun. See backend/docs/target_validation_notes.md for the full
architectural review (why this lives here, not in compile_intent() or a
new endpoint, and the accepted double-fetch tradeoff).

DELIBERATE ASYMMETRY -- read before changing this file:

  - Target UNREACHABLE / OpenAPI document unfetchable -> does NOT raise.
    "Unreachable right now" and "reachable but this endpoint doesn't
    exist" are different failure modes. Rejecting a plan merely because
    the target couldn't be reached at the exact moment of run CREATION
    would be a false-negative source, not a real compatibility verdict --
    and it would also require every caller (including every existing test
    that deliberately submits an unreachable placeholder target to
    exercise unrelated run-lifecycle behavior) to always have a live,
    reachable target on hand just to create a run. That case remains
    exactly what it already was: deferred to execute_run's own unchanged
    handling (EXECUTION_ERROR via RealK6PerformanceEngine), which is the
    one place actually equipped to retry/observe a target that may become
    reachable by the time the background task runs.
  - Target reachable AND at least one selected_endpoints entry
    demonstrably absent from its real OpenAPI surface -> DOES raise. This
    is the one case with positive evidence of incompatibility, and is
    exactly the proven gap this module exists to close (a literal path
    like "/products/1" compiling READY against the schema alone, but not
    existing against a real target whose actual template is
    "/products/{product_id}").
"""
from __future__ import annotations

from app.schemas.test_plan import TargetConfig, TestPlan
from app.services.auth_headers import build_auth_headers
from app.services.k6_engine.endpoint_resolver import ResolutionError, resolve_selected_endpoints
from app.services.k6_engine.openapi_loader import OpenAPILoadError, load_normalized


class TargetValidationError(Exception):
    """The TestPlan is already structurally/semantically valid on its own
    (it already passed TestPlan's own schema validation, and usually
    compile_intent()'s structural endpoint check too) -- this is a
    property of the (plan, target) PAIR, not of the plan alone. Distinct
    from WorkloadLimitExceededError, which is a property of the plan
    alone and never depends on any target."""


def validate_target_compatibility(plan: TestPlan, target: TargetConfig) -> None:
    """Raises TargetValidationError only when target.base_url's OpenAPI
    document was successfully fetched AND at least one
    plan.selected_endpoints entry does not resolve against it. Never
    raises when the target can't be reached or its document can't be
    parsed -- see the module docstring's "DELIBERATE ASYMMETRY" note.
    Any other exception is a genuine bug, not a compatibility verdict,
    and is allowed to propagate.
    """
    try:
        spec = load_normalized(
            target.base_url,
            openapi_url=target.openapi_url,
            headers=build_auth_headers(target.auth),
        )
    except OpenAPILoadError:
        return  # cannot verify right now -- defer to execute_run, unchanged

    try:
        resolve_selected_endpoints(spec, plan.selected_endpoints)
    except ResolutionError as exc:
        raise TargetValidationError(str(exc)) from exc
