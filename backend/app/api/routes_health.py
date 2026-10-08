"""Health and readiness probes (Phase 11).

LIVENESS (GET /api/v1/health): the process is up and serving HTTP. Verifies
NOTHING else -- no k6 lookup, no target HTTP call, no DB I/O. A liveness
probe that checks dependencies becomes a restart engine: if k6 or a target
is down, restarting the API process cannot fix that, and a failing probe
would turn a recoverable dependency outage into a crash loop.
Unauthenticated by design (harmless constant; never exposes anything).

READINESS (GET /api/v1/health/ready): whether this process can plausibly
ACCEPT work. Safe checks ONLY, in order:
  1. configuration validation (workload limits parse as positive ints;
     artifact directory is creatable) -- pure local I/O;
  2. k6 binary PRESENCE -- `shutil.which`, a PATH lookup only. k6 is never
     EXECUTED here (a readiness check must not cost seconds or leave
     subprocess state behind) and never hits the demo target or any other
     network endpoint.
Every check is required, so the response is a single status plus a list of
failed check NAMES. The response contains no secret VALUES and no
filesystem paths (only whether the artifact directory is usable).

Deployment guidance: point a platform's liveness probe at /health and its
readiness gate at /health/ready. A pod/container that fails readiness is
removed from rotation, not restarted.
"""

from shutil import which

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import K6_BINARY, MAX_DURATION_S, MAX_VUS

router = APIRouter()


class HealthResponse(BaseModel):
    status: str


class ReadyCheck(BaseModel):
    name: str
    ok: bool


class ReadinessResponse(BaseModel):
    status: str  # "ready" | "not_ready"
    checks: list[ReadyCheck]


@router.get("/health")
def health() -> HealthResponse:
    """Liveness only. Always 200 while the process can serve at all."""
    return HealthResponse(status="ok")


@router.get("/health/ready")
def ready() -> ReadinessResponse:
    checks = [
        ReadyCheck(name="workload_limits_configured", ok=MAX_VUS > 0 and MAX_DURATION_S > 0),
        ReadyCheck(name="artifacts_dir_usable", ok=_artifacts_dir_usable()),
        ReadyCheck(name="k6_binary_present", ok=which(K6_BINARY) is not None),
    ]
    ok = all(c.ok for c in checks)
    return ReadinessResponse(status="ready" if ok else "not_ready", checks=checks)


def _artifacts_dir_usable() -> bool:
    """The artifact root exists and accepts a write. This is the same
    directory every real run writes into (config.ARTIFACTS_DIR, created at
    import time); probing a THROWAWAY temp file inside it proves the
    execution plane can actually record results."""
    try:
        from app.core.config import ARTIFACTS_DIR

        if not ARTIFACTS_DIR.is_dir():
            return False
        probe = ARTIFACTS_DIR / ".readiness-probe"
        probe.write_text("ok")
        probe.unlink()
        return True
    except OSError:
        return False
