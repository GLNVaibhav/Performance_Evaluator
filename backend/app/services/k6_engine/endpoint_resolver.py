"""Resolve TestPlan.selected_endpoints (bare path strings, e.g. "/checkout")
against the normalized OpenAPI document into concrete (method, EndpointSpec)
pairs, and fill in path parameters with deterministic valid values.

TestPlan.selected_endpoints carries no HTTP method (see
app/schemas/test_plan.py) -- just the path. Resolution policy, since the
canonical demo API never actually has ambiguity in practice (each selected
path exposes exactly one non-trivial method):

  - exactly one method registered for that path  -> use it
  - zero methods registered                       -> ResolutionError
                                                       (path not in spec at all)
  - more than one method registered                -> fixed preference order
                                                       GET > POST > PUT > PATCH > DELETE,
                                                       documented limitation, not silently
                                                       arbitrary
"""
from __future__ import annotations

from dataclasses import dataclass

from app.services.k6_engine.openapi_loader import EndpointSpec, NormalizedOpenAPI

_METHOD_PREFERENCE = ("get", "post", "put", "patch", "delete")


class ResolutionError(RuntimeError):
    """Selected endpoint doesn't exist in the fetched spec, or a required
    path parameter has no usable schema. Execution failure, not a
    performance FAIL -- the plan can't be run at all as specified."""


@dataclass
class ResolvedEndpoint:
    spec: EndpointSpec
    resolved_path: str  # path template with {param} placeholders substituted


def _path_param_value(schema: dict) -> str:
    """Deterministic value for a path parameter. Same rules as
    payload_generator's scalar generation, kept separate because path
    params are always stringified into a URL, never JSON-encoded."""
    schema_type = schema.get("type", "string")
    if schema.get("enum"):
        return str(schema["enum"][0])
    if schema_type == "integer":
        return "1"
    if schema_type == "number":
        return "1.0"
    if schema_type == "boolean":
        return "true"
    return "test"


def _substitute_path_params(endpoint: EndpointSpec) -> str:
    resolved = endpoint.path
    for param in endpoint.path_params:
        placeholder = "{" + param.name + "}"
        if placeholder not in resolved:
            continue
        resolved = resolved.replace(placeholder, _path_param_value(param.schema))
    return resolved


def resolve_selected_endpoints(
    spec: NormalizedOpenAPI, selected_endpoints: list[str]
) -> list[ResolvedEndpoint]:
    resolved: list[ResolvedEndpoint] = []
    for path in selected_endpoints:
        candidates = spec.find(path)
        if not candidates:
            raise ResolutionError(
                f"selected_endpoints entry '{path}' does not exist in the target's OpenAPI document"
            )

        if len(candidates) == 1:
            chosen = candidates[0]
        else:
            by_method = {c.method: c for c in candidates}
            chosen = next(
                (by_method[m] for m in _METHOD_PREFERENCE if m in by_method),
                candidates[0],
            )

        resolved.append(ResolvedEndpoint(spec=chosen, resolved_path=_substitute_path_params(chosen)))

    return resolved
