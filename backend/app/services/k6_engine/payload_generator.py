"""Deterministic payload generation from an OpenAPI request-body schema.

No LLM, no randomness (deterministic is a hard requirement -- section 21
and section 9). Same JSON body is generated on every call for a given
schema; k6 script variety, if ever needed, is k6's own concern, not this
module's.

Supported (section 9's explicit minimum): string, integer, number,
boolean, array, object, with required/enum/default/example handling.
Anything genuinely unsupported (e.g. a schema with no 'type' and no
$ref-resolvable structure) fails LOUDLY -- never silently emits {} or a
best-guess garbage value.
"""
from __future__ import annotations

from typing import Any


class UnsupportedSchemaError(RuntimeError):
    """A schema element has no deterministic generation rule. Execution
    failure -- section 9: 'fail explicitly ... do NOT silently generate
    invalid garbage.'"""


def _example_value(schema: dict) -> Any:
    """OpenAPI 'example' (singular) is the common case for hand-written
    specs; some tools emit 'examples' (plural, dict-of-named-examples).
    Prefer an explicit example/default over generating one -- it's the
    author's own stated intent."""
    if "example" in schema:
        return schema["example"]
    if "default" in schema:
        return schema["default"]
    if "examples" in schema and isinstance(schema["examples"], dict) and schema["examples"]:
        first = next(iter(schema["examples"].values()))
        if isinstance(first, dict) and "value" in first:
            return first["value"]
    return None


def generate_value(schema: dict) -> Any:
    if not isinstance(schema, dict):
        raise UnsupportedSchemaError(f"expected a schema object, got {type(schema).__name__}")

    example = _example_value(schema)
    if example is not None:
        return example

    if "enum" in schema:
        if not schema["enum"]:
            raise UnsupportedSchemaError("enum schema with no allowed values")
        return schema["enum"][0]

    schema_type = schema.get("type")

    if schema_type == "string":
        return "test"
    if schema_type == "integer":
        return 1
    if schema_type == "number":
        return 1.0
    if schema_type == "boolean":
        return True
    if schema_type == "array":
        items_schema = schema.get("items")
        if not items_schema:
            raise UnsupportedSchemaError("array schema with no 'items'")
        return [generate_value(items_schema)]
    if schema_type == "object" or (schema_type is None and "properties" in schema):
        return generate_object(schema)

    raise UnsupportedSchemaError(f"no generation rule for schema type: {schema_type!r} ({schema})")


def generate_object(schema: dict) -> dict:
    properties: dict = schema.get("properties", {})
    required: set[str] = set(schema.get("required", []))

    result: dict[str, Any] = {}
    for name, prop_schema in properties.items():
        # MVP scope: always populate required fields; also populate
        # optional ones (simpler, still schema-valid, and the canonical
        # demo API's schemas have no optional fields that matter for
        # traffic generation). Documented, not accidental.
        result[name] = generate_value(prop_schema)

    missing_required = required - result.keys()
    if missing_required:
        raise UnsupportedSchemaError(
            f"required propert{'y' if len(missing_required) == 1 else 'ies'} "
            f"{sorted(missing_required)} not present in 'properties' -- cannot "
            "generate a schema-valid object"
        )

    return result


def generate_request_body(schema: dict | None) -> dict | None:
    """Top-level entry point. None schema (GET endpoints, or a POST with
    no requestBody) -> None, meaning: no JSON body should be sent."""
    if schema is None:
        return None
    return generate_object(schema) if schema.get("type", "object") == "object" else generate_value(schema)
