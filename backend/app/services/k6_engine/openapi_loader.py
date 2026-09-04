"""Fetch and normalize the target's OpenAPI document.

Fetched once per `execute()` call via GET {base_url}/openapi.json (the
canonical demo API's convention -- see demo-api/app/main.py, FastAPI
serves this automatically). Downstream modules (endpoint_resolver,
payload_generator) only ever see the normalized dataclasses below, never
raw OpenAPI JSON.

No LLM anywhere in this file, per section 21 of the brief.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

import httpx


class OpenAPILoadError(RuntimeError):
    """Raised for anything that makes the spec unusable: unreachable host,
    non-200 response, invalid JSON, or a missing 'paths' key. Callers
    (engine.py) treat this as an execution failure, never a performance
    FAIL -- fetching the contract is a precondition for the test to mean
    anything at all."""


@dataclass
class ParamSpec:
    name: str
    location: str  # "path" | "query"
    schema: dict
    required: bool = False


@dataclass
class EndpointSpec:
    path: str                      # raw template, e.g. "/products/{product_id}"
    method: str                    # lowercase: "get" | "post" | ...
    operation_id: Optional[str]
    request_schema: Optional[dict]      # resolved application/json schema, or None
    path_params: list[ParamSpec] = field(default_factory=list)
    query_params: list[ParamSpec] = field(default_factory=list)


@dataclass
class NormalizedOpenAPI:
    endpoints: list[EndpointSpec]
    raw: dict  # kept only for schema $ref resolution in payload_generator; never inspected elsewhere

    def find(self, path: str) -> list[EndpointSpec]:
        """All methods registered under this exact path template."""
        return [e for e in self.endpoints if e.path == path]


def fetch_openapi(base_url: str, timeout_s: float = 10.0) -> dict:
    url = base_url.rstrip("/") + "/openapi.json"
    try:
        response = httpx.get(url, timeout=timeout_s)
    except httpx.HTTPError as exc:
        raise OpenAPILoadError(f"could not reach {url}: {exc}") from exc

    if response.status_code != 200:
        raise OpenAPILoadError(f"{url} returned HTTP {response.status_code}")

    try:
        return response.json()
    except ValueError as exc:
        raise OpenAPILoadError(f"{url} did not return valid JSON: {exc}") from exc


def _resolve_ref(raw: dict, ref: str) -> dict:
    """Resolve a local '#/components/schemas/Foo'-style $ref. Only local
    refs are supported -- sufficient for the canonical demo API and
    intentionally not a general $ref/allOf/oneOf resolver (section 9:
    avoid excessive recursive complexity)."""
    if not ref.startswith("#/"):
        raise OpenAPILoadError(f"unsupported non-local $ref: {ref}")
    node: Any = raw
    for part in ref.lstrip("#/").split("/"):
        node = node.get(part, {}) if isinstance(node, dict) else {}
    return node


def _resolve_request_schema(raw: dict, operation: dict) -> Optional[dict]:
    request_body = operation.get("requestBody")
    if not request_body:
        return None
    schema = (
        request_body.get("content", {})
        .get("application/json", {})
        .get("schema", {})
    )
    if "$ref" in schema:
        return _resolve_ref(raw, schema["$ref"])
    return schema or None


def normalize(raw: dict) -> NormalizedOpenAPI:
    if "paths" not in raw:
        raise OpenAPILoadError("OpenAPI document has no 'paths' key")

    endpoints: list[EndpointSpec] = []
    for path_str, path_item in raw["paths"].items():
        for method, operation in path_item.items():
            if method.lower() not in ("get", "post", "put", "patch", "delete"):
                continue

            path_params: list[ParamSpec] = []
            query_params: list[ParamSpec] = []
            for p in operation.get("parameters", []):
                spec = ParamSpec(
                    name=p["name"],
                    location=p.get("in", "query"),
                    schema=p.get("schema", {"type": "string"}),
                    required=p.get("required", False),
                )
                if spec.location == "path":
                    path_params.append(spec)
                elif spec.location == "query":
                    query_params.append(spec)

            endpoints.append(
                EndpointSpec(
                    path=path_str,
                    method=method.lower(),
                    operation_id=operation.get("operationId"),
                    request_schema=_resolve_request_schema(raw, operation),
                    path_params=path_params,
                    query_params=query_params,
                )
            )

    return NormalizedOpenAPI(endpoints=endpoints, raw=raw)


def load_normalized(base_url: str) -> NormalizedOpenAPI:
    return normalize(fetch_openapi(base_url))
