"""In-memory, per-run bridge for the parts of TargetConfig that
run_service.execute_run() needs but TestRunRecord does NOT persist:
`openapi_url` and `auth` (app/storage/models.py::TestRunRecord only ever
stored `target_base_url`, a plain string -- unchanged by this work).

WHY THIS EXISTS: `execute_run()` is a FastAPI BackgroundTask that reopens
its own DB session and reconstructs a TargetConfig from the persisted
`target_base_url` alone (app/services/run_service.py). If `auth` were
never carried forward, a run whose OpenAPI document requires
authentication would validate correctly at creation time (create_run's
target_validation gate has `request.target` in hand directly) and then
fail during background execution once the credential is gone. This store
closes that gap WITHOUT writing the secret to the database.

DELIBERATE, DOCUMENTED LIMITATION (see docs/target_auth_contract.md):
this is a single-process, in-memory dict. It does not survive a process
restart between run creation and background execution, and it has no
place in a future multi-process/distributed task-queue deployment -- that
would need a real secret manager (e.g. a short-TTL encrypted-at-rest
store), which is explicitly out of scope for this MVP. Acceptable here
specifically because create_run() and execute_run() run in the same
process, moments apart, exactly like every other piece of this backend's
current single-process execution model (see app/services/run_service.py's
own module docstring).

Entries are removed once a run reaches a terminal state
(run_service.execute_run's `finally`), so a secret never lingers in memory
longer than the run that needed it.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Dict, Optional

from app.schemas.auth import AuthConfig


@dataclass
class TargetContext:
    openapi_url: Optional[str]
    auth: Optional[AuthConfig]


_store: Dict[str, TargetContext] = {}
_lock = threading.Lock()


def put(run_id: str, context: TargetContext) -> None:
    with _lock:
        _store[run_id] = context


def get(run_id: str) -> Optional[TargetContext]:
    with _lock:
        return _store.get(run_id)


def discard(run_id: str) -> None:
    with _lock:
        _store.pop(run_id, None)
