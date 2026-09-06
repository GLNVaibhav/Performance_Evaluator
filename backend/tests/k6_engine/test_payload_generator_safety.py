"""Session 3: payload_generator.py's new safety bounds (depth, array size,
body size) and the `boundary` PayloadStrategy. Complements
test_payload_generator.py (unmodified -- every existing assertion there
still holds byte-for-byte with the new `strategy`/depth parameters at
their defaults).
"""
import pytest

from app.core.config import MAX_PAYLOAD_ARRAY_ITEMS, MAX_PAYLOAD_BODY_BYTES, MAX_PAYLOAD_DEPTH
from app.schemas.enums import PayloadStrategy
from app.services.k6_engine.payload_generator import (
    UnsupportedSchemaError,
    generate_request_body,
    generate_value,
)


# --- normal strategy: unaffected by this amendment -------------------------


def test_normal_strategy_is_the_default_and_unchanged():
    assert generate_value({"type": "integer", "maximum": 100}) == 1
    assert generate_value({"type": "integer", "maximum": 100}, PayloadStrategy.normal) == 1


# --- boundary strategy: numeric edges ---------------------------------------


def test_boundary_integer_uses_maximum_when_present():
    assert generate_value({"type": "integer", "maximum": 100}, PayloadStrategy.boundary) == 100


def test_boundary_integer_uses_minimum_when_no_maximum():
    assert generate_value({"type": "integer", "minimum": 5}, PayloadStrategy.boundary) == 5


def test_boundary_prefers_maximum_over_minimum_when_both_present():
    assert generate_value({"type": "integer", "minimum": 5, "maximum": 100}, PayloadStrategy.boundary) == 100


def test_boundary_number_uses_exclusive_minimum_numeric_style():
    """Matches the canonical demo API's real, live CartRequest schema shape
    (`"exclusiveMinimum": 0.0`, a JSON-Schema-2020-12-style NUMBER, not the
    legacy OpenAPI 3.0 boolean sibling of `minimum`)."""
    value = generate_value({"type": "integer", "exclusiveMinimum": 0}, PayloadStrategy.boundary)
    assert value == 1


def test_boundary_falls_back_to_normal_when_no_bound_declared():
    assert generate_value({"type": "integer"}, PayloadStrategy.boundary) == 1
    assert generate_value({"type": "number"}, PayloadStrategy.boundary) == 1.0


def test_boundary_boolean_is_unaffected_no_meaningful_edge():
    assert generate_value({"type": "boolean"}, PayloadStrategy.boundary) is True


# --- boundary strategy: strings ---------------------------------------------


def test_boundary_string_uses_max_length():
    value = generate_value({"type": "string", "maxLength": 10}, PayloadStrategy.boundary)
    assert value == "x" * 10


def test_boundary_string_uses_min_length_when_no_max():
    value = generate_value({"type": "string", "minLength": 3}, PayloadStrategy.boundary)
    assert value == "xxx"


def test_boundary_string_falls_back_to_normal_when_no_length_constraint():
    assert generate_value({"type": "string"}, PayloadStrategy.boundary) == "test"


# --- boundary strategy: enum -------------------------------------------------


def test_normal_enum_picks_first_boundary_enum_picks_last():
    schema = {"type": "string", "enum": ["b", "a", "c"]}
    assert generate_value(schema, PayloadStrategy.normal) == "b"
    assert generate_value(schema, PayloadStrategy.boundary) == "c"


# --- example/default always win over either strategy ------------------------


def test_explicit_example_wins_over_boundary_strategy():
    schema = {"type": "integer", "maximum": 100, "example": 7}
    assert generate_value(schema, PayloadStrategy.boundary) == 7


# --- array sizing: minItems honored, maxItems only drives boundary ----------


def test_array_with_no_min_or_max_still_generates_one_item_both_strategies():
    schema = {"type": "array", "items": {"type": "integer"}}
    assert generate_value(schema, PayloadStrategy.normal) == [1]
    assert generate_value(schema, PayloadStrategy.boundary) == [1]


def test_array_min_items_is_honored_for_normal_strategy():
    """Previously ignored entirely (always exactly 1 item) -- now
    respected so a `minItems`-bearing schema gets a schema-valid array."""
    schema = {"type": "array", "items": {"type": "integer"}, "minItems": 3}
    assert generate_value(schema, PayloadStrategy.normal) == [1, 1, 1]


def test_array_boundary_strategy_uses_max_items():
    schema = {"type": "array", "items": {"type": "integer"}, "minItems": 1, "maxItems": 5}
    result = generate_value(schema, PayloadStrategy.boundary)
    assert result == [1, 1, 1, 1, 1]


def test_array_size_is_capped_at_max_payload_array_items_regardless_of_schema():
    schema = {"type": "array", "items": {"type": "integer"}, "maxItems": 999_999}
    result = generate_value(schema, PayloadStrategy.boundary)
    assert len(result) == MAX_PAYLOAD_ARRAY_ITEMS


def test_array_min_items_is_also_capped():
    schema = {"type": "array", "items": {"type": "integer"}, "minItems": 999_999}
    result = generate_value(schema, PayloadStrategy.normal)
    assert len(result) == MAX_PAYLOAD_ARRAY_ITEMS


# --- depth limit -------------------------------------------------------------


def _nested_object_schema(depth: int) -> dict:
    schema = {"type": "integer"}
    for _ in range(depth):
        schema = {"type": "object", "properties": {"child": schema}, "required": ["child"]}
    return schema


def test_schema_within_depth_limit_generates_successfully():
    # Each object-nesting level costs 2 depth units (one entering
    # generate_value's object branch, one for generate_object's own check
    # before recursing into the child) -- 3 levels stays comfortably under
    # MAX_PAYLOAD_DEPTH=12 by default regardless of exact accounting.
    schema = _nested_object_schema(3)
    generate_value(schema)  # must not raise


def test_pathologically_deep_schema_raises_instead_of_recursing_forever():
    schema = _nested_object_schema(MAX_PAYLOAD_DEPTH * 3)
    with pytest.raises(UnsupportedSchemaError):
        generate_value(schema)


def test_pathologically_deep_array_nesting_raises():
    schema = {"type": "integer"}
    for _ in range(MAX_PAYLOAD_DEPTH * 3):
        schema = {"type": "array", "items": schema}
    with pytest.raises(UnsupportedSchemaError):
        generate_value(schema)


# --- whole-body size limit ---------------------------------------------------


def test_oversized_generated_body_raises_instead_of_being_sent():
    # 2000 string properties, each maxLength 100 -> way over MAX_PAYLOAD_BODY_BYTES.
    properties = {f"field_{i}": {"type": "string", "maxLength": 100} for i in range(2000)}
    schema = {"type": "object", "properties": properties, "required": []}
    with pytest.raises(UnsupportedSchemaError):
        generate_request_body(schema, PayloadStrategy.boundary)


def test_normal_sized_body_is_unaffected_by_the_size_check():
    schema = {
        "type": "object",
        "properties": {"product_id": {"type": "integer"}, "quantity": {"type": "integer"}},
        "required": ["product_id"],
    }
    assert generate_request_body(schema) == {"product_id": 1, "quantity": 1}


# --- existing /cart and /checkout schemas remain intact ----------------------


def test_real_cart_request_schema_unaffected_by_safety_bounds():
    schema = {
        "properties": {
            "product_id": {"type": "integer", "title": "Product Id"},
            "quantity": {"type": "integer", "exclusiveMinimum": 0.0, "title": "Quantity", "default": 1},
        },
        "type": "object",
        "required": ["product_id"],
        "title": "CartRequest",
    }
    assert generate_request_body(schema) == {"product_id": 1, "quantity": 1}
    # quantity's `default: 1` wins over boundary strategy (author's stated
    # intent, same as `example`); product_id has no min/max bound at all,
    # so boundary falls back to the exact same normal value.
    assert generate_request_body(schema, PayloadStrategy.boundary) == {"product_id": 1, "quantity": 1}


def test_real_checkout_request_schema_unaffected_by_safety_bounds():
    schema = {
        "properties": {"cart_id": {"type": "string", "title": "Cart Id"}},
        "type": "object",
        "required": ["cart_id"],
        "title": "CheckoutRequest",
    }
    assert generate_request_body(schema) == {"cart_id": "test"}
    assert generate_request_body(schema, PayloadStrategy.boundary) == {"cart_id": "test"}
