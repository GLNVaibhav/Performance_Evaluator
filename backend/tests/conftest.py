import os
import socket
import tempfile
import threading
import time
from pathlib import Path

import pytest

# Must happen before `app.core.config` (or anything importing it) is first
# imported, since it reads these at import time. Isolated per test session
# so tests never touch a developer's real app.db / artifacts/.
_tmp_dir = Path(tempfile.mkdtemp(prefix="perfeval_test_"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(_tmp_dir / 'test.db').resolve()}")
os.environ.setdefault("ARTIFACTS_DIR", str((_tmp_dir / "artifacts").resolve()))
os.environ.setdefault("K6_EXECUTION_TIMEOUT_S", "60")
os.environ.setdefault("MAX_VUS", "2000")
os.environ.setdefault("MAX_DURATION_S", "90")

import uvicorn  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app as backend_app  # noqa: E402
from app.storage.db import SessionLocal, init_db  # noqa: E402
from tests.stub_target.app import app as stub_app  # noqa: E402

# Service/repository-level tests talk to the DB directly (no HTTP client),
# so the schema must exist before they run regardless of collection order --
# don't rely on the `client` fixture's lifespan startup for that.
init_db()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_port(host: str, port: int, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"stub target did not start listening on {host}:{port}")


@pytest.fixture(scope="session")
def stub_target_url():
    """Starts the throwaway stub target (tests/stub_target/app.py) on a free
    local port for the duration of the test session. Not the canonical
    demo API -- see that module's docstring."""

    port = _free_port()
    config = uvicorn.Config(stub_app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    _wait_for_port("127.0.0.1", port, timeout=10)

    yield f"http://127.0.0.1:{port}"

    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture()
def client():
    with TestClient(backend_app) as c:
        yield c


@pytest.fixture()
def db_session():
    """Direct DB session for service/repository-level tests that don't go
    through the HTTP API (e.g. failure-semantics tests using a fake
    engine). Independent connection to the same SQLite file the app uses,
    same as run_service's background-task session is independent of the
    request session in production."""

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
