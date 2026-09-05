"""Regression coverage for TestPlan.endpoint_weights validation
(app/schemas/test_plan.py::_PlanBase._validate_endpoint_weights) -- the
endpoint-mix feature's entry point. Deliberately structural/unit-level: no
engine, no k6, no DB."""

import pytest
from pydantic import ValidationError

from app.schemas.test_plan import FixedLoadPlan, Thresholds

_THRESHOLDS = Thresholds(p95_latency_ms=1000, error_rate=0.05)


def _plan(**overrides):
    payload = dict(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=["/products", "/checkout"],
        target_vus=10,
        duration="10s",
    )
    payload.update(overrides)
    return FixedLoadPlan(**payload)


def test_no_weights_is_valid_and_means_uniform():
    """Backward compatibility: every plan written before this feature
    existed has no endpoint_weights field at all."""
    plan = _plan()
    assert plan.endpoint_weights is None


def test_valid_weights_matching_selected_endpoints_are_accepted():
    plan = _plan(endpoint_weights={"/products": 60, "/checkout": 40})
    assert plan.endpoint_weights == {"/products": 60, "/checkout": 40}


def test_weights_need_not_sum_to_1_or_100():
    """Normalization happens in script_renderer, not at the schema layer --
    the schema only checks coverage and positivity."""
    plan = _plan(endpoint_weights={"/products": 7, "/checkout": 3})
    assert plan.endpoint_weights == {"/products": 7, "/checkout": 3}


def test_negative_weight_is_rejected():
    with pytest.raises(ValidationError, match="non-positive"):
        _plan(endpoint_weights={"/products": -1, "/checkout": 40})


def test_zero_weight_is_rejected():
    with pytest.raises(ValidationError, match="non-positive"):
        _plan(endpoint_weights={"/products": 0, "/checkout": 40})


def test_missing_weight_for_a_selected_endpoint_is_rejected():
    """A malformed mapping that omits a selected endpoint must never be
    silently treated as "unweighted" or defaulted -- that would be exactly
    the kind of hidden guess this feature must not make."""
    with pytest.raises(ValidationError, match="missing weight"):
        _plan(endpoint_weights={"/products": 100})


def test_weight_for_an_unselected_endpoint_is_rejected():
    with pytest.raises(ValidationError, match="unselected endpoint"):
        _plan(endpoint_weights={"/products": 60, "/checkout": 30, "/search": 10})


def test_boundary_search_plan_also_supports_endpoint_weights():
    """endpoint_weights lives on _PlanBase, so both plan shapes inherit
    the same validation -- not re-implemented per subclass."""
    from app.schemas.test_plan import BoundarySearchPlan

    plan = BoundarySearchPlan(
        test_type="stress",
        thresholds=_THRESHOLDS,
        selected_endpoints=["/products", "/checkout"],
        endpoint_weights={"/products": 80, "/checkout": 20},
        target_vus=100,
        ramp_duration="5s",
        hold_duration="10s",
    )
    assert plan.endpoint_weights == {"/products": 80, "/checkout": 20}
