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

from app.core.config import MAX_OPENAPI_DOC_BYTES, MAX_REF_RESOLUTION_DEPTH


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


def _fetch_json(url: str, timeout_s: float = 10.0, headers: Optional[dict] = None) -> dict:
    """Low-level fetch, shared by `fetch_openapi()` (derives the URL from a
    base_url) and `load_normalized()`'s explicit `openapi_url` override
    (uses the given URL as-is). `headers` is passed to `httpx.get()` only
    when truthy, so a no-auth call is byte-for-byte the same call existing
    tests already monkeypatch (`monkeypatch.setattr(httpx, "get", ...)`
    with a two-positional-arg fake) -- see
    tests/k6_engine/test_openapi_loader.py."""
    try:
        response = httpx.get(url, timeout=timeout_s, headers=headers) if headers else httpx.get(
            url, timeout=timeout_s
        )
    except httpx.HTTPError as exc:
        raise OpenAPILoadError(f"could not reach {url}: {exc}") from exc

    if response.status_code != 200:
        raise OpenAPILoadError(f"{url} returned HTTP {response.status_code}")

    # Hackathon-grade, not a true streaming cap: httpx.get() above already
    # fully downloaded the response before this check runs, so this bounds
    # how large a document we go on to parse/hold in memory, not how many
    # bytes were transferred. A true cap would need httpx.stream() with an
    # incremental byte-count abort -- not done here because
    # tests/k6_engine/test_openapi_loader.py monkeypatches httpx.get (not
    # httpx.stream) directly; switching fetch mechanisms would require
    # updating that test's mock for no behavioral gain at this project's
    # scale (single small demo-API-sized documents).
    if len(response.content) > MAX_OPENAPI_DOC_BYTES:
        raise OpenAPILoadError(
            f"{url} response ({len(response.content)} bytes) exceeds the "
            f"{MAX_OPENAPI_DOC_BYTES}-byte limit for an OpenAPI document"
        )

    try:
        return response.json()
    except ValueError as exc:
        raise OpenAPILoadError(f"{url} did not return valid JSON: {exc}") from exc


def fetch_openapi(base_url: str, timeout_s: float = 10.0, headers: Optional[dict] = None) -> dict:
    url = base_url.rstrip("/") + "/openapi.json"
    return _fetch_json(url, timeout_s=timeout_s, headers=headers)


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


def _deref_tree(raw: dict, node: Any, active_refs: frozenset, depth: int) -> Any:
    """Recursively resolves EVERY $ref appearing anywhere in `node`'s tree
    (properties, array items -- nested arbitrarily), not just a schema's
    own top-level $ref (which is all `_resolve_ref` alone ever handled
    before Session 3). Closes the documented, proven gap in
    docs/target_api_notes.md section 6: a nested-model list (`items:
    {"$ref": ...}` inside an array) previously reached
    app/services/k6_engine/payload_generator.py unresolved and failed with
    "no generation rule for schema type: None".

    Cycle-safe: a $ref that would re-enter itself (a legitimate recursive-
    type shape, e.g. a tree/linked-list schema) is left UNRESOLVED once
    detected, rather than expanded forever -- payload_generator.py already
    fails loudly on an unresolved $ref node (no `type` key it recognizes),
    which is the correct, safe behavior for a schema this system cannot
    deterministically generate a FINITE payload for. Also bounded by
    MAX_REF_RESOLUTION_DEPTH regardless of cycle detection, as a defense-
    in-depth safety net against a very long (but acyclic) $ref chain --
    OpenAPI documents are now user-supplied (Session 1's OpenAPI URL
    input), so this loader must never hang or exhaust the Python call
    stack on an adversarial document."""
    if depth > MAX_REF_RESOLUTION_DEPTH:
        return node
    if isinstance(node, dict):
        if "$ref" in node:
            ref = node["$ref"]
            if ref in active_refs:
                return node  # cycle detected -- leave unresolved, fails loud downstream
            resolved = _resolve_ref(raw, ref)
            return _deref_tree(raw, resolved, active_refs | {ref}, depth + 1)
        return {key: _deref_tree(raw, value, active_refs, depth + 1) for key, value in node.items()}
    if isinstance(node, list):
        return [_deref_tree(raw, item, active_refs, depth + 1) for item in node]
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
    if not schema:
        return None
    resolved = _deref_tree(raw, schema, frozenset(), 0)
    return resolved or None


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


def load_normalized(
    base_url: str,
    *,
    openapi_url: Optional[str] = None,
    headers: Optional[dict] = None,
) -> NormalizedOpenAPI:
    """`openapi_url`, when given, is fetched AS-IS (no `/openapi.json`
    suffix derivation) -- an explicit override for a target whose spec
    lives somewhere other than `{base_url}/openapi.json`. `headers` (see
    app/services/auth_headers.py::build_auth_headers()) authenticates the
    fetch itself; it has no bearing on where the document says real
    requests should go (`base_url`, entirely separate -- see
    app/schemas/test_plan.py::TargetConfig's docstring). Omitting both
    keyword arguments reproduces the exact prior behavior and call
    signature -- every existing caller (`load_normalized(target.base_url)`)
    is unaffected."""
    if openapi_url:
        raw = _fetch_json(openapi_url, headers=headers)
    else:
        raw = fetch_openapi(base_url, headers=headers)
    return normalize(raw)
