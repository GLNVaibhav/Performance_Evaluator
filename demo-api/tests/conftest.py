import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.state import reset_runtime_state


@pytest.fixture(autouse=True)
def _reset_state():
    reset_runtime_state()
    yield
    reset_runtime_state()


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
