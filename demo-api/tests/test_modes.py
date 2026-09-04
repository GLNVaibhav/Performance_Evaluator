import time

import pytest


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode",
    ["normal", "db_latency", "checkout_bottleneck", "error_injection"],
)
async def test_demo_mode_accepts_valid(client, mode):
    response = await client.post("/demo/mode", json={"mode": mode})
    assert response.status_code == 200
    assert response.json()["mode"] == mode


@pytest.mark.asyncio
async def test_invalid_demo_mode_rejected(client):
    response = await client.post("/demo/mode", json={"mode": "evil_mode"})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_switching_back_to_normal_works(client):
    await client.post("/demo/mode", json={"mode": "error_injection"})
    response = await client.post("/demo/mode", json={"mode": "normal"})
    assert response.status_code == 200
    assert response.json()["mode"] == "normal"


async def _time_checkout(client) -> float:
    cart_response = await client.post("/cart", json={"product_id": 1, "quantity": 1})
    cart_id = cart_response.json()["cart_id"]
    start = time.perf_counter()
    response = await client.post("/checkout", json={"cart_id": cart_id})
    elapsed = time.perf_counter() - start
    assert response.status_code == 200
    return elapsed


@pytest.mark.asyncio
async def test_checkout_bottleneck_slower_than_normal(client):
    await client.post("/demo/mode", json={"mode": "normal"})
    normal_elapsed = await _time_checkout(client)

    await client.post("/demo/mode", json={"mode": "checkout_bottleneck"})
    slow_elapsed = await _time_checkout(client)

    assert slow_elapsed > normal_elapsed + 0.3


@pytest.mark.asyncio
async def test_error_injection_produces_controlled_5xx(client):
    await client.post("/demo/mode", json={"mode": "error_injection"})
    statuses = []
    for _ in range(30):
        response = await client.get("/products")
        statuses.append(response.status_code)
    assert any(status >= 500 for status in statuses)
    assert any(status == 200 for status in statuses)


@pytest.mark.asyncio
async def test_normal_mode_restores_success(client):
    await client.post("/demo/mode", json={"mode": "error_injection"})
    await client.post("/demo/mode", json={"mode": "normal"})
    for _ in range(10):
        response = await client.get("/products")
        assert response.status_code == 200
