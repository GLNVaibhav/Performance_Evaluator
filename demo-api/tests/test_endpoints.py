import pytest


@pytest.mark.asyncio
async def test_products_list_ok(client):
    response = await client.get("/products")
    assert response.status_code == 200
    body = response.json()
    assert "products" in body
    assert len(body["products"]) >= 5


@pytest.mark.asyncio
async def test_product_by_id_ok(client):
    response = await client.get("/products/1")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == 1
    assert body["name"] == "Laptop"


@pytest.mark.asyncio
async def test_cart_ok(client):
    response = await client.post("/cart", json={"product_id": 1, "quantity": 1})
    assert response.status_code == 200
    body = response.json()
    assert body["cart_id"]
    assert len(body["items"]) == 1
    assert body["total"] > 0


@pytest.mark.asyncio
async def test_checkout_ok(client):
    cart_response = await client.post("/cart", json={"product_id": 2, "quantity": 1})
    cart_id = cart_response.json()["cart_id"]

    response = await client.post("/checkout", json={"cart_id": cart_id})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "confirmed"
    assert body["cart_id"] == cart_id
    assert body["order_id"]


@pytest.mark.asyncio
async def test_login_ok(client):
    response = await client.post(
        "/login",
        json={"username": "demo", "password": "demo123"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["token"]
    assert body["username"] == "demo"
