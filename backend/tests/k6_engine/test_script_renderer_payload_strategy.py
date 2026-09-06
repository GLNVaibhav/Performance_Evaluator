"""Session 3: TestPlan.payload_strategy threads through render_script() to
payload_generator.py -- static/unit-level (no k6 needed). Real end-to-end
proof (does the actual byte sent over the wire change) lives in
test_payload_strategy_execution.py.
"""
from app.schemas.enums import PayloadStrategy
from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.openapi_loader import normalize
from app.services.k6_engine.script_renderer import render_script

_TARGET = TargetConfig(base_url="http://127.0.0.1:8080")
_THRESHOLDS = Thresholds(p95_latency_ms=2000, error_rate=0.01)
_SPEC = normalize(
    {
        "paths": {
            "/cart": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "product_id": {"type": "integer", "maximum": 9999},
                                        "quantity": {"type": "integer"},
                                    },
                                    "required": ["product_id"],
                                }
                            }
                        }
                    }
                }
            }
        }
    }
)


def _plan(payload_strategy: PayloadStrategy) -> FixedLoadPlan:
    return FixedLoadPlan(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=["/cart"],
        target_vus=10,
        duration="10s",
        payload_strategy=payload_strategy,
    )


def test_default_payload_strategy_is_normal():
    plan = FixedLoadPlan(
        test_type="baseline", thresholds=_THRESHOLDS, selected_endpoints=["/cart"], target_vus=10, duration="10s"
    )
    assert plan.payload_strategy == PayloadStrategy.normal


def test_normal_strategy_renders_the_unchanged_default_value():
    script = render_script(_plan(PayloadStrategy.normal), _TARGET, _SPEC)
    assert '"product_id": 1' in script


def test_boundary_strategy_renders_the_schema_declared_maximum():
    script = render_script(_plan(PayloadStrategy.boundary), _TARGET, _SPEC)
    assert '"product_id": 9999' in script
    assert '"product_id": 1' not in script
