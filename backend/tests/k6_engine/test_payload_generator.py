import pytest

from app.services.k6_engine.payload_generator import (
    UnsupportedSchemaError,
    generate_object,
    generate_request_body,
    generate_value,
)


def test_none_schema_means_no_body():
    assert generate_request_body(None) is None


def test_string_type():
    assert generate_value({"type": "string"}) == "test"


def test_integer_type():
    assert generate_value({"type": "integer"}) == 1


def test_number_type():
    assert generate_value({"type": "number"}) == 1.0


def test_boolean_type():
    assert generate_value({"type": "boolean"}) is True


def test_enum_returns_first_value():
    assert generate_value({"type": "string", "enum": ["b", "a", "c"]}) == "b"


def test_array_generates_one_item():
    assert generate_value({"type": "array", "items": {"type": "integer"}}) == [1]


def test_default_value_takes_precedence_over_type_generation():
    assert generate_value({"type": "integer", "default": 42}) == 42


def test_example_value_takes_precedence_over_default():
    assert generate_value({"type": "integer", "default": 42, "example": 7}) == 7


def test_required_object_fields_populated():
    schema = {
        "type": "object",
        "properties": {
            "product_id": {"type": "integer"},
            "quantity": {"type": "integer", "default": 1},
        },
        "required": ["product_id"],
    }
    body = generate_object(schema)
    assert body == {"product_id": 1, "quantity": 1}


def test_matches_real_cart_request_schema():
    # Captured verbatim from the canonical demo API's live /openapi.json.
    schema = {
        "properties": {
            "product_id": {"type": "integer", "title": "Product Id"},
            "quantity": {
                "type": "integer",
                "exclusiveMinimum": 0.0,
                "title": "Quantity",
                "default": 1,
            },
        },
        "type": "object",
        "required": ["product_id"],
        "title": "CartRequest",
    }
    assert generate_request_body(schema) == {"product_id": 1, "quantity": 1}


def test_matches_real_checkout_request_schema():
    schema = {
        "properties": {"cart_id": {"type": "string", "title": "Cart Id"}},
        "type": "object",
        "required": ["cart_id"],
        "title": "CheckoutRequest",
    }
    assert generate_request_body(schema) == {"cart_id": "test"}


def test_unsupported_type_raises_explicitly():
    with pytest.raises(UnsupportedSchemaError):
        generate_value({"type": "null"})


def test_missing_required_property_definition_raises():
    schema = {"type": "object", "properties": {}, "required": ["mystery_field"]}
    with pytest.raises(UnsupportedSchemaError):
        generate_object(schema)


def test_array_with_no_items_raises_explicitly():
    with pytest.raises(UnsupportedSchemaError):
        generate_value({"type": "array"})
