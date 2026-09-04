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

import uvicorn  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app as backend_app  # noqa: E402
from tests.stub_target.app import app as stub_app  # noqa: E402


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
