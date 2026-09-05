import asyncio

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
async def test_categories_list_ok(client):
    response = await client.get("/categories")
    assert response.status_code == 200
    body = response.json()
    assert "categories" in body
    assert len(body["categories"]) >= 1
    assert {"id", "name", "description"} <= body["categories"][0].keys()


@pytest.mark.asyncio
async def test_category_by_id_ok(client):
    response = await client.get("/categories/1")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == 1


@pytest.mark.asyncio
async def test_category_by_id_not_found(client):
    response = await client.get("/categories/9999")
    assert response.status_code == 404


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


# --- Concurrency / multi-user isolation -------------------------------------


@pytest.mark.asyncio
async def test_concurrent_carts_do_not_corrupt_or_mix_state(client):
    """Simulates N independent 'logical users' hitting POST /cart at the
    same time (asyncio.gather -- genuine concurrent requests against the
    same in-process app, exercising app/state.py's lock exactly as real
    concurrent k6 VUs would). Each must get its own distinct cart_id and a
    total that reflects ONLY its own items -- never another caller's."""
    user_requests = [
        {"product_id": 1, "quantity": 1},
        {"product_id": 2, "quantity": 3},
        {"product_id": 3, "quantity": 2},
        {"product_id": 4, "quantity": 5},
        {"product_id": 5, "quantity": 1},
        {"product_id": 6, "quantity": 1},
        {"product_id": 7, "quantity": 2},
        {"product_id": 8, "quantity": 4},
    ] * 5  # 40 concurrent "users"

    responses = await asyncio.gather(*(client.post("/cart", json=req) for req in user_requests))

    assert all(r.status_code == 200 for r in responses)
    bodies = [r.json() for r in responses]

    cart_ids = [b["cart_id"] for b in bodies]
    assert len(set(cart_ids)) == len(cart_ids)  # every cart_id is unique -- no collisions

    for req, body in zip(user_requests, bodies):
        # A strong, simple check that this response's item is genuinely
        # THIS caller's own, not another concurrent caller's.
        assert len(body["items"]) == 1
        assert body["items"][0]["product_id"] == req["product_id"]
        assert body["items"][0]["quantity"] == req["quantity"]


@pytest.mark.asyncio
async def test_concurrent_users_can_independently_checkout_without_cross_contamination(client):
    """The full create-cart -> checkout chain, run concurrently for
    multiple independent logical users, proving order_id/cart_id pairing
    is never mixed up under concurrent load."""

    async def _one_user_flow(product_id: int, quantity: int):
        cart_resp = await client.post("/cart", json={"product_id": product_id, "quantity": quantity})
        assert cart_resp.status_code == 200
        cart_id = cart_resp.json()["cart_id"]
        checkout_resp = await client.post("/checkout", json={"cart_id": cart_id})
        assert checkout_resp.status_code == 200
        body = checkout_resp.json()
        assert body["cart_id"] == cart_id
        return body["order_id"], cart_id

    results = await asyncio.gather(*(_one_user_flow((i % 8) + 1, 1) for i in range(20)))

    order_ids = [r[0] for r in results]
    cart_ids = [r[1] for r in results]
    assert len(set(order_ids)) == len(order_ids)  # every order is distinct
    assert len(set(cart_ids)) == len(cart_ids)  # every cart is distinct


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
