import pytest

from app.services.k6_engine.endpoint_resolver import ResolutionError, resolve_selected_endpoints
from app.services.k6_engine.openapi_loader import normalize

_DEMO_LIKE_SPEC = {
    "paths": {
        "/products": {"get": {}},
        "/products/{product_id}": {
            "get": {
                "parameters": [
                    {"name": "product_id", "in": "path", "required": True, "schema": {"type": "integer"}}
                ]
            }
        },
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
    }
}


def test_resolves_get_endpoint():
    spec = normalize(_DEMO_LIKE_SPEC)
    [resolved] = resolve_selected_endpoints(spec, ["/products"])
    assert resolved.spec.method == "get"
    assert resolved.resolved_path == "/products"


def test_resolves_post_endpoint():
    spec = normalize(_DEMO_LIKE_SPEC)
    [resolved] = resolve_selected_endpoints(spec, ["/cart"])
    assert resolved.spec.method == "post"


def test_substitutes_integer_path_parameter():
    spec = normalize(_DEMO_LIKE_SPEC)
    [resolved] = resolve_selected_endpoints(spec, ["/products/{product_id}"])
    assert resolved.resolved_path == "/products/1"
    assert "{" not in resolved.resolved_path


def test_raises_for_unknown_path():
    spec = normalize(_DEMO_LIKE_SPEC)
    with pytest.raises(ResolutionError):
        resolve_selected_endpoints(spec, ["/does-not-exist"])


def test_prefers_get_when_multiple_methods_registered():
    spec = normalize({"paths": {"/thing": {"post": {}, "get": {}}}})
    [resolved] = resolve_selected_endpoints(spec, ["/thing"])
    assert resolved.spec.method == "get"
