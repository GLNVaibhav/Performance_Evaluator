import uuid

from fastapi import APIRouter, HTTPException, status

from app.models import CheckoutRequest, ErrorResponse, OrderResponse
from app.modes import maybe_fail_request
from app.state import apply_checkout_delay, get_cart

router = APIRouter(tags=["checkout"])


@router.post(
    "/checkout",
    response_model=OrderResponse,
    status_code=status.HTTP_200_OK,
    responses={
        status.HTTP_404_NOT_FOUND: {"model": ErrorResponse},
        status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ErrorResponse},
    },
)
async def checkout(payload: CheckoutRequest) -> OrderResponse:
    await maybe_fail_request()
    cart = get_cart(payload.cart_id)
    if cart is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Cart {payload.cart_id} not found",
        )

    await apply_checkout_delay()
    return OrderResponse(
        order_id=str(uuid.uuid4()),
        cart_id=cart.cart_id,
        status="confirmed",
        total=cart.total,
    )
