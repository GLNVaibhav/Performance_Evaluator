"""Deterministic payload generation from an OpenAPI request-body schema.

No LLM, no randomness (deterministic is a hard requirement -- section 21
and section 9). Same JSON body is generated on every call for a given
schema AND strategy; k6 script variety, if ever needed, is k6's own
concern, not this module's.

Supported (section 9's explicit minimum): string, integer, number,
boolean, array, object, with required/enum/default/example handling.
Anything genuinely unsupported (e.g. a schema with no 'type' and no
$ref-resolvable structure) fails LOUDLY -- never silently emits {} or a
best-guess garbage value.

--- Safety bounds (Session 3, additive) ------------------------------------

Session 1 opened OpenAPI *discovery* to an arbitrary user-supplied URL
(app/services/k6_engine/openapi_loader.py) -- a request-body schema
reaching this module is therefore no longer necessarily authored by this
project's own team. Three independent, configurable bounds
(app/core/config.py) protect against a pathological or adversarial schema
turning into a pathological generated payload, without changing behavior
for any real-world schema this project has ever exercised:

  MAX_PAYLOAD_DEPTH        -- recursion ceiling while walking nested
                              properties/array-items. Raises
                              UnsupportedSchemaError (fail loud, never a
                              truncated/garbage value) if exceeded.
  MAX_PAYLOAD_ARRAY_ITEMS  -- generated array length never exceeds this,
                              regardless of the schema's own `maxItems`.
  MAX_PAYLOAD_BODY_BYTES   -- the fully-generated body's serialized JSON
                              size is checked once, at generate_request_
                              body()'s top level; exceeding it raises
                              UnsupportedSchemaError rather than handing
                              script_renderer.py an oversized body.

None of these bounds change output for any schema already covered by
tests/k6_engine/test_payload_generator.py -- every existing call with no
`strategy`/depth argument behaves byte-for-byte as before (see that file
for the byte-identical assertions this relies on).

--- Payload strategy (Session 3, additive) ---------------------------------

`strategy` (app/schemas/enums.py::PayloadStrategy) selects between exactly
two fixed, deterministic generation rules -- never a fuzzing framework,
never randomness:

  normal    (default) -- unchanged pre-existing behavior.
  boundary  -- pushes each generated value to the nearest schema-declared
               edge (maximum/minimum or exclusiveMaximum/exclusiveMinimum
               for numbers, maxLength/minLength for strings, maxItems/
               minItems for arrays, the LAST enum value instead of the
               first) -- falling back to the exact `normal` value for any
               field with no such edge declared. An explicit `example`/
               `default` on the schema still always wins over either
               strategy (the author's own stated intent is never
               second-guessed by a strategy).
"""
from __future__ import annotations

import json
from typing import Any, Optional

from app.core.config import MAX_PAYLOAD_ARRAY_ITEMS, MAX_PAYLOAD_BODY_BYTES, MAX_PAYLOAD_DEPTH
from app.schemas.enums import PayloadStrategy


class UnsupportedSchemaError(RuntimeError):
    """A schema element has no deterministic generation rule -- OR a
    configured safety bound (depth/size) was exceeded. Both are execution
    failures (section 9: 'fail explicitly ... do NOT silently generate
    invalid garbage'); a caller does not need to distinguish which, since
    neither ever produces a usable payload."""


def _example_value(schema: dict) -> Any:
    """OpenAPI 'example' (singular) is the common case for hand-written
    specs; some tools emit 'examples' (plural, dict-of-named-examples).
    Prefer an explicit example/default over generating one -- it's the
    author's own stated intent, and takes precedence over BOTH strategies
    below (a strategy chooses among GENERATED values; it never overrides
    a value the schema author already gave explicitly)."""
    if "example" in schema:
        return schema["example"]
    if "default" in schema:
        return schema["default"]
    if "examples" in schema and isinstance(schema["examples"], dict) and schema["examples"]:
        first = next(iter(schema["examples"].values()))
        if isinstance(first, dict) and "value" in first:
            return first["value"]
    return None


def _numeric_bound(schema: dict, *, integer: bool) -> Optional[Any]:
    """Boundary-strategy numeric edge: prefers the upper bound
    (maximum/exclusiveMaximum) over the lower one (minimum/
    exclusiveMinimum) when both exist, matching this module's documented
    "push to the nearest declared edge, preferring the upper edge" rule.
    `exclusiveMaximum`/`exclusiveMinimum` are read only as NUMBERS (JSON
    Schema 2020-12 / Pydantic's own emitted style -- confirmed against the
    canonical demo API's real, live CartRequest schema:
    `"exclusiveMinimum": 0.0`), never as the legacy OpenAPI 3.0 boolean
    sibling-of-`maximum` form -- `bool` is explicitly excluded even though
    `isinstance(True, int)` is true in Python, to avoid silently treating
    a boolean flag as a numeric edge."""

    def _is_number(v: Any) -> bool:
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    if _is_number(schema.get("maximum")):
        value = schema["maximum"]
    elif _is_number(schema.get("exclusiveMaximum")):
        value = schema["exclusiveMaximum"] - 1
    elif _is_number(schema.get("minimum")):
        value = schema["minimum"]
    elif _is_number(schema.get("exclusiveMinimum")):
        value = schema["exclusiveMinimum"] + 1
    else:
        return None
    return int(value) if integer else float(value)


def _boundary_string(schema: dict) -> Optional[str]:
    max_length = schema.get("maxLength")
    min_length = schema.get("minLength")
    if isinstance(max_length, int) and not isinstance(max_length, bool):
        # Sanity ceiling independent of the schema's own maxLength -- a
        # schema could declare an enormous maxLength; this is a request
        # BODY safety bound (MAX_PAYLOAD_BODY_BYTES) applied per-field too,
        # so one field alone can never dominate the whole-body cap.
        return "x" * max(min(max_length, MAX_PAYLOAD_BODY_BYTES // 4), 0)
    if isinstance(min_length, int) and not isinstance(min_length, bool) and min_length > 0:
        return "x" * min(min_length, MAX_PAYLOAD_BODY_BYTES // 4)
    return None


def _array_item_count(schema: dict, strategy: PayloadStrategy) -> int:
    """Item count for a generated array. Unchanged default (exactly 1,
    regardless of strategy) when the schema declares neither `minItems`
    nor `maxItems` -- see test_array_generates_one_item, still true for
    `strategy=normal` and for `boundary` alike when no bound is declared.
    A declared `minItems` is honored (previously ignored entirely) for
    BOTH strategies, since generating fewer than `minItems` values would
    make the body schema-invalid, which normal generation should not do
    either; `maxItems` only changes generation count under `boundary`
    (deliberately pushing to the upper edge). Both are always capped at
    MAX_PAYLOAD_ARRAY_ITEMS regardless of what the schema itself declares."""
    min_items = schema.get("minItems")
    max_items = schema.get("maxItems")
    has_min = isinstance(min_items, int) and not isinstance(min_items, bool) and min_items > 0
    has_max = isinstance(max_items, int) and not isinstance(max_items, bool) and max_items >= 0

    if strategy == PayloadStrategy.boundary and has_max:
        return min(max(max_items, 0), MAX_PAYLOAD_ARRAY_ITEMS)
    if strategy == PayloadStrategy.boundary and has_min:
        return min(min_items, MAX_PAYLOAD_ARRAY_ITEMS)
    if has_min:
        return min(min_items, MAX_PAYLOAD_ARRAY_ITEMS)
    return 1


def generate_value(schema: dict, strategy: PayloadStrategy = PayloadStrategy.normal, _depth: int = 0) -> Any:
    if not isinstance(schema, dict):
        raise UnsupportedSchemaError(f"expected a schema object, got {type(schema).__name__}")

    if _depth > MAX_PAYLOAD_DEPTH:
        raise UnsupportedSchemaError(
            f"schema nesting exceeded MAX_PAYLOAD_DEPTH={MAX_PAYLOAD_DEPTH} -- "
            "refusing to generate a value for a pathologically deep schema"
        )

    example = _example_value(schema)
    if example is not None:
        return example

    if "enum" in schema:
        if not schema["enum"]:
            raise UnsupportedSchemaError("enum schema with no allowed values")
        return schema["enum"][-1] if strategy == PayloadStrategy.boundary else schema["enum"][0]

    schema_type = schema.get("type")

    if schema_type == "string":
        if strategy == PayloadStrategy.boundary:
            boundary = _boundary_string(schema)
            if boundary is not None:
                return boundary
        return "test"
    if schema_type == "integer":
        if strategy == PayloadStrategy.boundary:
            boundary = _numeric_bound(schema, integer=True)
            if boundary is not None:
                return boundary
        return 1
    if schema_type == "number":
        if strategy == PayloadStrategy.boundary:
            boundary = _numeric_bound(schema, integer=False)
            if boundary is not None:
                return boundary
        return 1.0
    if schema_type == "boolean":
        # No meaningful "boundary" concept for a two-valued type -- same
        # value for both strategies, intentionally (see module docstring).
        return True
    if schema_type == "array":
        items_schema = schema.get("items")
        if not items_schema:
            raise UnsupportedSchemaError("array schema with no 'items'")
        count = _array_item_count(schema, strategy)
        return [generate_value(items_schema, strategy, _depth + 1) for _ in range(count)]
    if schema_type == "object" or (schema_type is None and "properties" in schema):
        return generate_object(schema, strategy, _depth + 1)

    raise UnsupportedSchemaError(f"no generation rule for schema type: {schema_type!r} ({schema})")


def generate_object(schema: dict, strategy: PayloadStrategy = PayloadStrategy.normal, _depth: int = 0) -> dict:
    if _depth > MAX_PAYLOAD_DEPTH:
        raise UnsupportedSchemaError(
            f"schema nesting exceeded MAX_PAYLOAD_DEPTH={MAX_PAYLOAD_DEPTH} -- "
            "refusing to generate a value for a pathologically deep schema"
        )

    properties: dict = schema.get("properties", {})
    required: set[str] = set(schema.get("required", []))

    result: dict[str, Any] = {}
    for name, prop_schema in properties.items():
        # MVP scope: always populate required fields; also populate
        # optional ones (simpler, still schema-valid, and the canonical
        # demo API's schemas have no optional fields that matter for
        # traffic generation). Documented, not accidental.
        result[name] = generate_value(prop_schema, strategy, _depth + 1)

    missing_required = required - result.keys()
    if missing_required:
        raise UnsupportedSchemaError(
            f"required propert{'y' if len(missing_required) == 1 else 'ies'} "
            f"{sorted(missing_required)} not present in 'properties' -- cannot "
            "generate a schema-valid object"
        )

    return result


def generate_request_body(schema: dict | None, strategy: PayloadStrategy = PayloadStrategy.normal) -> dict | None:
    """Top-level entry point. None schema (GET endpoints, or a POST with
    no requestBody) -> None, meaning: no JSON body should be sent."""
    if schema is None:
        return None
    body = generate_object(schema, strategy) if schema.get("type", "object") == "object" else generate_value(
        schema, strategy
    )

    # Whole-body size bound -- checked once, here, rather than trying to
    # bound every individual field in isolation (a schema with e.g. 500
    # simple string properties could exceed this even though no single
    # field is individually oversized).
    serialized_size = len(json.dumps(body))
    if serialized_size > MAX_PAYLOAD_BODY_BYTES:
        raise UnsupportedSchemaError(
            f"generated request body ({serialized_size} bytes) exceeds "
            f"MAX_PAYLOAD_BODY_BYTES={MAX_PAYLOAD_BODY_BYTES} -- refusing to send an "
            "oversized payload"
        )
    return body
