"""Session 5: static (no k6 needed) checks that script_renderer.py emits
the recordHttpStatus() mechanism correctly and the result stays valid JS.
Real end-to-end proof (are exact observed statuses actually recorded)
lives in test_status_code_execution.py.
"""
import shutil
import subprocess

import pytest

from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.k6_engine.openapi_loader import normalize
from app.services.k6_engine.script_renderer import render_script

_TARGET = TargetConfig(base_url="http://127.0.0.1:8080")
_THRESHOLDS = Thresholds(p95_latency_ms=2000, error_rate=0.01)
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
_node_required = pytest.mark.skipif(shutil.which("node") is None, reason="Node not available")


def _plan(*endpoints: str) -> FixedLoadPlan:
    return FixedLoadPlan(
        test_type="baseline", thresholds=_THRESHOLDS, selected_endpoints=list(endpoints), target_vus=10, duration="10s"
    )


def test_record_http_status_function_is_always_emitted():
    script = render_script(_plan("/products"), _TARGET, _SPEC)
    assert "function recordHttpStatus(res)" in script
    assert "'http_status_' + res.status" in script


def test_get_request_calls_record_http_status():
    script = render_script(_plan("/products"), _TARGET, _SPEC)
    assert "recordHttpStatus(res_0);" in script


def test_post_request_calls_record_http_status():
    script = render_script(_plan("/cart"), _TARGET, _SPEC)
    assert "recordHttpStatus(res_0);" in script


def test_checkout_cart_dependency_both_calls_record_http_status():
    script = render_script(_plan("/checkout"), _TARGET, _SPEC)
    assert "recordHttpStatus(cartRes);" in script
    assert "recordHttpStatus(res_checkout);" in script


def test_record_http_status_call_never_affects_exit_code_it_is_always_true():
    """Structural guard: the check condition itself must be the constant
    `() => true` -- the same tautological-check discipline already used
    elsewhere in this file, never a real assertion that could fail."""
    script = render_script(_plan("/products"), _TARGET, _SPEC)
    assert "() => true" in script


@_node_required
def test_rendered_script_with_status_recording_is_syntactically_valid_js():
    script = render_script(_plan("/checkout"), _TARGET, _SPEC)
    result = subprocess.run(
        ["node", "--input-type=module", "--check"], input=script, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, f"rendered script with recordHttpStatus is not valid JS: {result.stderr}"
