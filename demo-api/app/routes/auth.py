from fastapi import APIRouter, HTTPException, status

from app.config import DEMO_PASSWORD, DEMO_TOKEN, DEMO_USERNAME
from app.models import ErrorResponse, LoginRequest, LoginResponse
from app.modes import maybe_fail_request

router = APIRouter(tags=["auth"])


@router.post(
    "/login",
    response_model=LoginResponse,
    status_code=status.HTTP_200_OK,
    responses={
        status.HTTP_401_UNAUTHORIZED: {"model": ErrorResponse},
        status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ErrorResponse},
    },
)
async def login(payload: LoginRequest) -> LoginResponse:
    await maybe_fail_request()
    if payload.username != DEMO_USERNAME or payload.password != DEMO_PASSWORD:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid demo credentials",
        )
    return LoginResponse(token=DEMO_TOKEN, username=payload.username)
