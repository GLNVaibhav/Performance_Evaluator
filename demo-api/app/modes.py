from fastapi import HTTPException, status

from app.models import DemoMode
from app.state import get_mode, should_inject_error


async def maybe_fail_request() -> None:
    if get_mode() != DemoMode.error_injection:
        return
    if should_inject_error():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Simulated service unavailable",
        )
