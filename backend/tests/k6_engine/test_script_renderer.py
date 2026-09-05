from app.schemas.test_plan import BoundarySearchPlan, FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.openapi_loader import normalize
from app.services.k6_engine.script_renderer import render_script

_SPEC = normalize(
    {
        "paths": {
            "/products": {"get": {}},
            "/cart": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {"product_id": {"type": "integer"}},
                                    "required": ["product_id"],
                                }
                            }
                        }
                    }
                }
            },
            "/checkout": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {"cart_id": {"type": "string"}},
                                    "required": ["cart_id"],
                                }
                            }
                        }
                    }
                }
            },
        }
    }
)

_TARGET = TargetConfig(base_url="http://127.0.0.1:8080")
_THRESHOLDS = Thresholds(p95_latency_ms=2000, error_rate=0.01)


def test_fixed_load_script_contains_base_url_and_vu_config():
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=["/products"],
        target_vus=100,
        duration="20s",
    )
    script = render_script(plan, _TARGET, _SPEC)
    assert "http://127.0.0.1:8080" in script
    assert "target: 100" in script
    assert "duration: '20s'" in script
    assert "http.get" in script
    assert "/products" in script


def test_boundary_search_script_has_ramp_then_hold_stages_only():
    plan = BoundarySearchPlan(
        test_type="stress",
        thresholds=_THRESHOLDS,
        selected_endpoints=["/products"],
        target_vus=1500,
        ramp_duration="5s",
        hold_duration="20s",
    )
    script = render_script(plan, _TARGET, _SPEC)
    assert script.count("target: 1500") == 2  # ramp stage + hold stage, both at the SAME level
    assert "'5s'" in script and "'20s'" in script
    # exactly one experiment: no other VU levels anywhere in the script
    assert "target: 500" not in script and "target: 1000" not in script


def test_post_endpoint_uses_correct_method_and_generated_body():
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=["/cart"],
        target_vus=10,
        duration="10s",
    )
    script = render_script(plan, _TARGET, _SPEC)
    assert "http.post" in script
    assert '"product_id": 1' in script


def test_checkout_endpoint_gets_the_cart_dependency_chain():
    plan = FixedLoadPlan(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=["/checkout"],
        target_vus=10,
        duration="10s",
    )
    script = render_script(plan, _TARGET, _SPEC)
    assert "cartRes" in script
    assert "cartId" in script
    assert "/cart" in script and "/checkout" in script
    # the checkout body must be threaded from the real cart response, not a static "test" string
    assert 'cart_id: cartId' in script.replace(" ", "") or "cart_id: cartId" in script
