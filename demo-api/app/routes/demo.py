from fastapi import APIRouter, status

from app.models import DemoMode, ErrorResponse, HealthResponse, ModeRequest, ModeResponse
from app.state import get_mode, set_mode

router = APIRouter(tags=["demo"])


@router.get(
    "/health",
    response_model=HealthResponse,
    status_code=status.HTTP_200_OK,
)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", mode=get_mode())


@router.get(
    "/demo/mode",
    response_model=ModeResponse,
    status_code=status.HTTP_200_OK,
)
async def get_demo_mode() -> ModeResponse:
    mode = get_mode()
    return ModeResponse(mode=mode, message=f"Current mode is {mode.value}")


@router.post(
    "/demo/mode",
    response_model=ModeResponse,
    status_code=status.HTTP_200_OK,
)
async def set_demo_mode(payload: ModeRequest) -> ModeResponse:
    mode = set_mode(payload.mode)
    return ModeResponse(mode=mode, message=f"Mode switched to {mode.value}")
