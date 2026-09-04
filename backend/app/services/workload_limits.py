"""Authoritative, server-side workload safety limits.

Pydantic (app/schemas/test_plan.py) only checks duration *syntax*
(`^\\d+(ms|s|m|h)$`) and that target_vus is a positive int -- that is
structural validation, not a safety limit. This module is the deterministic
gate that actually enforces MAX_VUS / MAX_DURATION_S, called from
run_service.create_run() before a plan is persisted or ever reaches k6.
Never rely on k6 or the subprocess timeout to fail safe.
"""

import re

from app.core.config import MAX_DURATION_S, MAX_VUS
from app.schemas.enums import ObjectiveType
from app.schemas.test_plan import TestPlan

_DURATION_RE = re.compile(r"^(\d+)(ms|s|m|h)$")
_UNIT_SECONDS = {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0}


class WorkloadLimitExceededError(Exception):
    pass


def parse_duration_seconds(value: str) -> float:
    """Deterministic k6-style duration string -> seconds. No LLM, no
    external library -- the format is small and fixed."""

    match = _DURATION_RE.match(value)
    if not match:
        raise WorkloadLimitExceededError(f"malformed duration: {value!r}")

    amount, unit = match.group(1), match.group(2)
    seconds = int(amount) * _UNIT_SECONDS[unit]
    if seconds <= 0:
        raise WorkloadLimitExceededError(f"duration must be greater than zero: {value!r}")
    return seconds


def validate_workload_limits(plan: TestPlan) -> None:
    """Raises WorkloadLimitExceededError if the plan's VU count or planned
    execution duration exceeds the configured MAX_VUS / MAX_DURATION_S.
    Applies uniformly to every TestPlan source (inline or hardcoded
    plan_id) since both funnel through run_service.create_run()."""

    if plan.target_vus > MAX_VUS:
        raise WorkloadLimitExceededError(
            f"target_vus={plan.target_vus} exceeds MAX_VUS={MAX_VUS}"
        )

    if plan.objective_type == ObjectiveType.boundary_search:
        # One experiment: ramp + hold, not a multi-stage ladder.
        total_duration_s = parse_duration_seconds(plan.ramp_duration) + parse_duration_seconds(
            plan.hold_duration
        )
    else:  # fixed_load
        total_duration_s = parse_duration_seconds(plan.duration)

    if total_duration_s > MAX_DURATION_S:
        raise WorkloadLimitExceededError(
            f"planned duration={total_duration_s:g}s exceeds MAX_DURATION_S={MAX_DURATION_S}"
        )
