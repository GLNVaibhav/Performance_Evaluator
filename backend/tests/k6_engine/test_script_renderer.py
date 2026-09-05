import shutil
import subprocess

import pytest

from app.schemas.test_plan import BoundarySearchPlan, FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.openapi_loader import normalize
from app.services.k6_engine.script_renderer import build_endpoint_tags, render_script

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


# --- Endpoint mix + per-endpoint evidence (additive feature) --------------

_node_required = pytest.mark.skipif(shutil.which("node") is None, reason="Node not available")


def _multi_endpoint_plan(**overrides):
    payload = dict(
        test_type="baseline",
        thresholds=_THRESHOLDS,
        selected_endpoints=["/products", "/cart"],
        target_vus=10,
        duration="10s",
    )
    payload.update(overrides)
    return FixedLoadPlan(**payload)


def test_uniform_dispatch_when_no_weights_given():
    """No endpoint_weights -> preserves the original uniform split: two
    endpoints means a 50/50 cumulative threshold."""
    script = render_script(_multi_endpoint_plan(), _TARGET, _SPEC)
    assert "const r = Math.random();" in script
    assert "if (r < 0.5)" in script


def test_weighted_dispatch_reflects_configured_weights():
    plan = _multi_endpoint_plan(endpoint_weights={"/products": 70, "/cart": 30})
    script = render_script(plan, _TARGET, _SPEC)
    assert "if (r < 0.7)" in script


def test_weights_need_not_sum_to_100_and_still_normalize_correctly():
    plan = _multi_endpoint_plan(endpoint_weights={"/products": 7, "/cart": 3})
    script = render_script(plan, _TARGET, _SPEC)
    assert "if (r < 0.7)" in script  # 7 / (7+3) == 0.7, same as the 70/30 case


def test_requests_are_tagged_with_backend_generated_aliases_not_raw_paths():
    """Aliases are endpoint_<i>, never the literal endpoint text -- see
    script_renderer.py module docstring for why (k6 threshold-selector
    syntax is a second, independent parser from the JS engine)."""
    script = render_script(_multi_endpoint_plan(), _TARGET, _SPEC)
    assert '"endpoint_0"' in script
    assert '"endpoint_1"' in script
    assert "tags:" in script


def test_build_endpoint_tags_maps_aliases_back_to_the_real_endpoint_strings():
    tags = build_endpoint_tags(_multi_endpoint_plan(), _SPEC)
    assert [t.alias for t in tags] == ["endpoint_0", "endpoint_1"]
    assert [t.endpoint for t in tags] == ["/products", "/cart"]
    assert tags[0].method == "GET"
    assert tags[1].method == "POST"


def test_per_endpoint_tautological_thresholds_are_emitted_for_every_selected_endpoint():
    """This is the verified mechanism (see performance_engine_interface.md)
    that makes k6 include a tagged submetric in --summary-export at all --
    without it, metrics_parser would have nothing to read."""
    script = render_script(_multi_endpoint_plan(), _TARGET, _SPEC)
    for alias in ("endpoint_0", "endpoint_1"):
        assert f"'http_req_duration{{endpoint:{alias}}}': ['p(95)>=0']," in script
        assert f"'http_reqs{{endpoint:{alias}}}': ['count>=0']," in script
        assert f"'http_req_failed{{endpoint:{alias}}}': ['rate>=0']," in script


def test_single_endpoint_plan_still_gets_a_threshold_and_tag():
    """Per-endpoint evidence applies even when there's only one endpoint --
    aggregate and per-endpoint should agree in that case."""
    plan = FixedLoadPlan(
        test_type="baseline", thresholds=_THRESHOLDS, selected_endpoints=["/products"], target_vus=10, duration="10s"
    )
    script = render_script(plan, _TARGET, _SPEC)
    assert '"endpoint_0"' in script
    assert "'http_reqs{endpoint:endpoint_0}': ['count>=0']," in script


@_node_required
def test_weighted_multi_endpoint_script_is_syntactically_valid_js():
    """Not just string-matched: the generated weighted-dispatch + tagging +
    thresholds JS must actually parse as valid JavaScript."""
    plan = _multi_endpoint_plan(endpoint_weights={"/products": 70, "/cart": 30})
    script = render_script(plan, _TARGET, _SPEC)
    result = subprocess.run(
        ["node", "--input-type=module", "--check"], input=script, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, f"rendered weighted script is not valid JS: {result.stderr}"
