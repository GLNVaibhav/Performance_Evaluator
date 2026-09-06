"""Tests for app/schemas/intent.py's `before`-mode field validators.

Regression coverage for a real observed bug: a live LLM call (via
LLMIntentInterpreter, OpenRouter gpt-4o-mini) reliably returned
`"success_criteria": null` for any mission that stated no threshold,
instead of `{"p95_latency_ms": null, "error_rate": null}`. Since
`success_criteria` (like `load_profile` and `target_scope`) uses
`Field(default_factory=...)`, not `Optional[...]`, Pydantic only applies
that default for a genuinely ABSENT key -- an explicit `null` raised a
validation error and discarded an otherwise-fine interpretation as
INTERPRETATION_FAILURE. `_coerce_explicit_null_to_empty_object` treats an
explicit null the same as an empty object for all three fields.
"""
from app.schemas.intent import UniversalPerformanceIntent


def test_null_success_criteria_is_coerced_to_empty_object():
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "stress",
            "load_profile": {"peak_users": 30},
            "duration": "8s",
            "target_scope": {"endpoints": ["/checkout"]},
            "success_criteria": None,
        }
    )
    assert intent.success_criteria.p95_latency_ms is None
    assert intent.success_criteria.error_rate is None


def test_null_load_profile_is_coerced_to_empty_object():
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "baseline",
            "load_profile": None,
            "duration": "10s",
            "target_scope": {"endpoints": ["/products"]},
        }
    )
    assert intent.load_profile.concurrent_users is None
    assert intent.load_profile.peak_users is None


def test_null_target_scope_is_coerced_to_empty_object():
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 10},
            "duration": "10s",
            "target_scope": None,
        }
    )
    assert intent.target_scope.endpoints is None


def test_omitted_success_criteria_still_defaults_normally():
    """The fix must not change existing behavior for the ABSENT-key case
    (default_factory), only add tolerance for the explicit-null case."""
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 10},
            "duration": "10s",
            "target_scope": {"endpoints": ["/products"]},
        }
    )
    assert intent.success_criteria.p95_latency_ms is None
    assert intent.success_criteria.error_rate is None


def test_explicit_success_criteria_values_pass_through_unaffected():
    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 10},
            "duration": "10s",
            "target_scope": {"endpoints": ["/products"]},
            "success_criteria": {"p95_latency_ms": 800, "error_rate": 0.02},
        }
    )
    assert intent.success_criteria.p95_latency_ms == 800
    assert intent.success_criteria.error_rate == 0.02
