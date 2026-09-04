"""Blocker 3: authoritative server-side workload limits. Unit-level
coverage of the duration parser and the plan-level gate, plus an
API-level check that oversized/malformed requests are rejected before
ever reaching run_service/k6.
"""

import pytest

from app.schemas.test_plan import BoundarySearchPlan, FixedLoadPlan, Thresholds
from app.services.workload_limits import (
    WorkloadLimitExceededError,
    parse_duration_seconds,
    validate_workload_limits,
)


def _thresholds() -> Thresholds:
    return Thresholds(p95_latency_ms=2000, error_rate=0.01)


@pytest.mark.parametrize(
    "value,expected_seconds",
    [("500ms", 0.5), ("10s", 10.0), ("2m", 120.0), ("1h", 3600.0)],
)
def test_parse_duration_seconds_units(value, expected_seconds):
    assert parse_duration_seconds(value) == expected_seconds


@pytest.mark.parametrize("value", ["10 seconds", "10", "s10", "-5s", "5x", ""])
def test_parse_duration_rejects_malformed(value):
    with pytest.raises(WorkloadLimitExceededError):
        parse_duration_seconds(value)


def test_parse_duration_rejects_zero():
    with pytest.raises(WorkloadLimitExceededError):
        parse_duration_seconds("0s")


def test_fixed_load_within_limits_is_accepted():
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=_thresholds(),
        selected_endpoints=["/products"],
        target_vus=10,
        duration="10s",
    )
    validate_workload_limits(plan)  # must not raise


def test_fixed_load_rejects_excessive_vus():
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=_thresholds(),
        selected_endpoints=["/products"],
        target_vus=10_000_000,
        duration="10s",
    )
    with pytest.raises(WorkloadLimitExceededError):
        validate_workload_limits(plan)


def test_fixed_load_rejects_excessive_duration():
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=_thresholds(),
        selected_endpoints=["/products"],
        target_vus=10,
        duration="1h",
    )
    with pytest.raises(WorkloadLimitExceededError):
        validate_workload_limits(plan)


def test_boundary_search_within_limits_is_accepted():
    plan = BoundarySearchPlan(
        test_type="stress",
        thresholds=_thresholds(),
        selected_endpoints=["/checkout"],
        target_vus=50,
        ramp_duration="5s",
        hold_duration="10s",
    )
    validate_workload_limits(plan)  # must not raise


def test_boundary_search_sums_ramp_and_hold_against_limit():
    """ramp_duration + hold_duration is treated as ONE experiment's total
    planned duration, not evaluated independently."""

    plan = BoundarySearchPlan(
        test_type="stress",
        thresholds=_thresholds(),
        selected_endpoints=["/checkout"],
        target_vus=10,
        ramp_duration="1h",
        hold_duration="1s",
    )
    with pytest.raises(WorkloadLimitExceededError):
        validate_workload_limits(plan)


def test_boundary_search_rejects_excessive_vus():
    plan = BoundarySearchPlan(
        test_type="stress",
        thresholds=_thresholds(),
        selected_endpoints=["/checkout"],
        target_vus=10_000_000,
        ramp_duration="5s",
        hold_duration="10s",
    )
    with pytest.raises(WorkloadLimitExceededError):
        validate_workload_limits(plan)


def test_api_rejects_plan_exceeding_max_vus(client):
    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 999_999_999,
        "duration": "5s",
        "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.01},
        "selected_endpoints": ["/products"],
    }
    resp = client.post(
        "/api/v1/runs",
        json={"plan": inline_plan, "target": {"base_url": "http://127.0.0.1:1"}},
    )
    assert resp.status_code == 422


def test_api_rejects_plan_exceeding_max_duration(client):
    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 10,
        "duration": "1h",
        "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.01},
        "selected_endpoints": ["/products"],
    }
    resp = client.post(
        "/api/v1/runs",
        json={"plan": inline_plan, "target": {"base_url": "http://127.0.0.1:1"}},
    )
    assert resp.status_code == 422


def test_api_rejects_malformed_duration_syntax(client):
    """Caught by Pydantic's structural pattern check, before workload
    limits are ever evaluated."""

    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 10,
        "duration": "10 seconds",
        "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.01},
        "selected_endpoints": ["/products"],
    }
    resp = client.post(
        "/api/v1/runs",
        json={"plan": inline_plan, "target": {"base_url": "http://127.0.0.1:1"}},
    )
    assert resp.status_code == 422
