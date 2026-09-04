import httpx
import pytest

from app.services.k6_engine.openapi_loader import OpenAPILoadError, fetch_openapi, normalize


def test_normalize_resolves_local_ref_request_body():
    raw = {
        "paths": {
            "/cart": {
                "post": {
                    "operationId": "add_to_cart",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/CartRequest"}
                            }
                        }
                    },
                }
            }
        },
        "components": {
            "schemas": {
                "CartRequest": {
                    "type": "object",
                    "properties": {"product_id": {"type": "integer"}},
                    "required": ["product_id"],
                }
            }
        },
    }
    spec = normalize(raw)
    assert len(spec.endpoints) == 1
    endpoint = spec.endpoints[0]
    assert endpoint.method == "post"
    assert endpoint.request_schema == {
        "type": "object",
        "properties": {"product_id": {"type": "integer"}},
        "required": ["product_id"],
    }


def test_normalize_extracts_path_and_query_params():
    raw = {
        "paths": {
            "/products/{product_id}": {
                "get": {
                    "parameters": [
                        {"name": "product_id", "in": "path", "required": True, "schema": {"type": "integer"}},
                        {"name": "verbose", "in": "query", "required": False, "schema": {"type": "boolean"}},
                    ]
                }
            }
        }
    }
    spec = normalize(raw)
    endpoint = spec.endpoints[0]
    assert [p.name for p in endpoint.path_params] == ["product_id"]
    assert [p.name for p in endpoint.query_params] == ["verbose"]


def test_normalize_ignores_non_http_method_keys():
    raw = {"paths": {"/products": {"get": {}, "parameters": []}}}  # 'parameters' is a sibling key, not a method
    spec = normalize(raw)
    assert len(spec.endpoints) == 1
    assert spec.endpoints[0].method == "get"


def test_normalize_rejects_document_with_no_paths():
    with pytest.raises(OpenAPILoadError):
        normalize({"openapi": "3.1.0"})


def test_fetch_openapi_raises_on_unreachable_host():
    with pytest.raises(OpenAPILoadError):
        fetch_openapi("http://127.0.0.1:1", timeout_s=1.0)


def test_fetch_openapi_raises_on_non_200(monkeypatch):
    class _FakeResponse:
        status_code = 500

    def _fake_get(url, timeout):
        return _FakeResponse()

    monkeypatch.setattr(httpx, "get", _fake_get)
    with pytest.raises(OpenAPILoadError):
        fetch_openapi("http://example.invalid")
