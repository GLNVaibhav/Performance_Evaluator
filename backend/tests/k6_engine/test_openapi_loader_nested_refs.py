"""Session 3: nested-$ref resolution (app/services/k6_engine/openapi_loader.py
::_deref_tree). Closes the gap documented in docs/target_api_notes.md
section 6 -- verified STILL present before this change (a `$ref` nested
inside an array's `items`, e.g. `items: List[SomeNestedModel]`, was
resolved only at the schema's own top level, never inside `properties`/
`items`, and reached payload_generator.py unresolved: "no generation rule
for schema type: None").
"""
import pytest

from app.services.k6_engine.openapi_loader import OpenAPILoadError, normalize
from app.services.k6_engine.payload_generator import generate_request_body


def _cart_with_nested_items_doc() -> dict:
    """The exact previously-failing shape from docs/target_api_notes.md
    section 6: `items: List[CartItemRequest]` -- a $ref nested inside an
    array's `items`, one level below the request body's own top-level
    $ref."""
    return {
        "paths": {
            "/cart": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {"schema": {"$ref": "#/components/schemas/CartRequest"}}
                        }
                    }
                }
            }
        },
        "components": {
            "schemas": {
                "CartRequest": {
                    "type": "object",
                    "properties": {
                        "items": {"type": "array", "items": {"$ref": "#/components/schemas/CartItemRequest"}}
                    },
                    "required": ["items"],
                },
                "CartItemRequest": {
                    "type": "object",
                    "properties": {
                        "product_id": {"type": "integer"},
                        "quantity": {"type": "integer", "default": 1},
                    },
                    "required": ["product_id"],
                },
            }
        },
    }


def test_nested_ref_inside_array_items_is_now_resolved():
    spec = normalize(_cart_with_nested_items_doc())
    endpoint = spec.endpoints[0]
    assert endpoint.request_schema == {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "product_id": {"type": "integer"},
                        "quantity": {"type": "integer", "default": 1},
                    },
                    "required": ["product_id"],
                },
            }
        },
        "required": ["items"],
    }


def test_nested_ref_resolution_enables_real_payload_generation():
    """The end-to-end proof: payload_generator.py needed ZERO changes to
    consume this (per the documented minimal-fix proposal) -- it just
    receives a fully-dereferenced schema now."""
    spec = normalize(_cart_with_nested_items_doc())
    schema = spec.endpoints[0].request_schema
    body = generate_request_body(schema)
    assert body == {"items": [{"product_id": 1, "quantity": 1}]}


def test_doubly_nested_ref_object_inside_object_is_resolved():
    doc = {
        "paths": {
            "/order": {
                "post": {
                    "requestBody": {
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Order"}}}
                    }
                }
            }
        },
        "components": {
            "schemas": {
                "Order": {
                    "type": "object",
                    "properties": {"shipping": {"$ref": "#/components/schemas/Address"}},
                    "required": ["shipping"],
                },
                "Address": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            }
        },
    }
    spec = normalize(doc)
    body = generate_request_body(spec.endpoints[0].request_schema)
    assert body == {"shipping": {"city": "test"}}


# --- Safety: cyclic and pathologically long $ref chains ---------------------


def test_self_referential_ref_does_not_hang_or_crash():
    """A legitimate recursive-type shape (e.g. a tree/linked-list schema)
    -- must resolve up to the cycle, then leave the innermost $ref
    unresolved rather than expanding forever. normalize() itself must
    never hang or raise a RecursionError."""
    doc = {
        "paths": {
            "/tree": {
                "post": {
                    "requestBody": {
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Node"}}}
                    }
                }
            }
        },
        "components": {
            "schemas": {
                "Node": {
                    "type": "object",
                    "properties": {
                        "value": {"type": "integer"},
                        "child": {"$ref": "#/components/schemas/Node"},
                    },
                    "required": ["value"],
                }
            }
        },
    }
    spec = normalize(doc)  # must not hang or raise
    schema = spec.endpoints[0].request_schema
    assert schema["properties"]["value"] == {"type": "integer"}
    # The cyclic branch is left as an unresolved $ref marker -- payload
    # generation for THIS field correctly fails loud rather than looping.
    assert "$ref" in schema["properties"]["child"]


def test_very_long_acyclic_ref_chain_is_bounded_not_crashed():
    """Defense in depth, independent of cycle detection: a very long but
    non-cyclic $ref chain must not exhaust the Python call stack."""
    schemas = {}
    chain_length = 100
    for i in range(chain_length):
        schemas[f"Link{i}"] = {
            "type": "object",
            "properties": {"next": {"$ref": f"#/components/schemas/Link{i + 1}"}},
            "required": [],
        }
    schemas[f"Link{chain_length}"] = {"type": "object", "properties": {}, "required": []}

    doc = {
        "paths": {
            "/chain": {
                "post": {
                    "requestBody": {
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Link0"}}}
                    }
                }
            }
        },
        "components": {"schemas": schemas},
    }
    normalize(doc)  # must not raise RecursionError or hang


def test_non_local_ref_still_raises_explicitly():
    doc = {
        "paths": {
            "/x": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {"y": {"$ref": "https://example.com/schemas/Foo.json"}},
                                    "required": ["y"],
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    with pytest.raises(OpenAPILoadError):
        normalize(doc)
