import pytest


@pytest.mark.asyncio
async def test_openapi_json_ok(client):
    response = await client.get("/openapi.json")
    assert response.status_code == 200
    spec = response.json()
    assert spec["openapi"].startswith("3.")
    assert "/products" in spec["paths"]
    assert "/products/{product_id}" in spec["paths"]
    assert "/categories" in spec["paths"]
    assert "/categories/{category_id}" in spec["paths"]
    assert "/checkout" in spec["paths"]
    assert "/cart" in spec["paths"]
    assert "/login" in spec["paths"]


@pytest.mark.asyncio
async def test_categories_endpoints_have_get_methods_in_openapi(client):
    spec = (await client.get("/openapi.json")).json()
    assert "get" in spec["paths"]["/categories"]
    assert "get" in spec["paths"]["/categories/{category_id}"]
    # path param must be a real, discoverable path parameter -- not
    # baked into the path as a literal, which is exactly what the
    # Performance Evaluator's endpoint resolver depends on (it resolves
    # OpenAPI PATH TEMPLATES, not example values -- see
    # backend/app/services/k6_engine/endpoint_resolver.py).
    params = spec["paths"]["/categories/{category_id}"]["get"]["parameters"]
    assert any(p["name"] == "category_id" and p["in"] == "path" for p in params)


@pytest.mark.asyncio
async def test_checkout_post_exists_in_openapi(client):
    spec = (await client.get("/openapi.json")).json()
    checkout = spec["paths"]["/checkout"]
    assert "post" in checkout
    assert "requestBody" in checkout["post"]


@pytest.mark.asyncio
async def test_cart_post_exists_in_openapi(client):
    spec = (await client.get("/openapi.json")).json()
    cart = spec["paths"]["/cart"]
    assert "post" in cart
    request_body = cart["post"]["requestBody"]
    schema_ref = request_body["content"]["application/json"]["schema"]["$ref"]
    assert schema_ref.endswith("CartRequest")
