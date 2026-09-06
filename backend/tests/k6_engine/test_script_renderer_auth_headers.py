"""Session 2.5: static (no k6 needed) checks on script_renderer.py's
AUTH_HEADERS mechanism -- fast unit-level coverage complementing the real
k6 execution proof in test_auth_propagation_execution.py.

render_script() takes no direct `auth` argument by design (see
script_renderer.py's module docstring) -- the AUTH_HEADERS/__ENV-reading
code is ALWAYS emitted, identically, regardless of whether the plan's
target has auth configured; only the k6 subprocess's environment (set by
engine.py, not tested here) determines whether AUTH_HEADERS is populated
at runtime. These tests verify that always-emitted code is present,
correctly wired into every request, and -- critically -- that no literal
secret-shaped string could ever end up in the generated source (there is
no code path that could put one there, since render_script never receives
a secret at all).
"""
import shutil
import subprocess

import pytest

from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
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
_node_required = pytest.mark.skipif(shutil.which("node") is None, reason="Node not available")


def _plan(*endpoints):
    return FixedLoadPlan(
        test_type="baseline", thresholds=_THRESHOLDS, selected_endpoints=list(endpoints), target_vus=10, duration="10s"
    )


def test_auth_env_reading_constants_are_always_emitted():
    script = render_script(_plan("/products"), _TARGET, _SPEC)
    assert "__ENV.PERF_EVAL_AUTH_HEADER_NAME" in script
    assert "__ENV.PERF_EVAL_AUTH_HEADER_VALUE" in script
    assert "const AUTH_HEADERS" in script


def test_bare_get_request_now_carries_a_headers_object():
    """Regression guard for the change from a bare http.get(url) to
    http.get(url, { headers: ... }) -- the single-endpoint, no-tag case."""
    script = render_script(_plan("/products"), _TARGET, _SPEC)
    assert "http.get(BASE_URL" in script
    assert "Object.assign({}, AUTH_HEADERS" in script


def test_post_request_merges_auth_headers_with_content_type():
    script = render_script(_plan("/cart"), _TARGET, _SPEC)
    assert "Object.assign({}, AUTH_HEADERS, { 'Content-Type': 'application/json' })" in script


def test_checkout_cart_dependency_cart_call_also_merges_auth_headers():
    script = render_script(_plan("/checkout"), _TARGET, _SPEC)
    # Both the internal /cart call and the /checkout call itself must use
    # the merged-headers expression -- appears at least twice.
    assert script.count("Object.assign({}, AUTH_HEADERS") >= 2


def test_no_literal_secret_shaped_value_possible_render_never_receives_one():
    """render_script's signature has no `auth`/secret parameter at all --
    this is a structural guarantee, not a string-matching one, but assert
    the obvious corollary: the generated source contains only the two
    fixed env-var NAMES, never anything else auth-shaped."""
    script = render_script(_plan("/products"), _TARGET, _SPEC)
    assert "Authorization" not in script  # no header NAME is hardcoded either -- fully data-driven via __ENV
    assert "Bearer" not in script


@_node_required
def test_rendered_script_with_auth_constants_is_syntactically_valid_js():
    script = render_script(_plan("/checkout"), _TARGET, _SPEC)
    result = subprocess.run(
        ["node", "--input-type=module", "--check"], input=script, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, f"rendered script with AUTH_HEADERS is not valid JS: {result.stderr}"
