from fastapi import APIRouter, HTTPException, status

from app.data import PRODUCTS_BY_ID
from app.models import CartItem, CartRequest, CartResponse, ErrorResponse
from app.modes import maybe_fail_request
from app.state import create_cart

router = APIRouter(tags=["cart"])


@router.post(
    "/cart",
    response_model=CartResponse,
    status_code=status.HTTP_200_OK,
    responses={
        status.HTTP_404_NOT_FOUND: {"model": ErrorResponse},
        status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ErrorResponse},
    },
)
async def add_to_cart(payload: CartRequest) -> CartResponse:
    await maybe_fail_request()
    product = PRODUCTS_BY_ID.get(payload.product_id)
    if product is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Product {payload.product_id} not found",
        )
    if payload.quantity > product.inventory:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Insufficient inventory for product {payload.product_id}",
        )

    item = CartItem(
        product_id=product.id,
        quantity=payload.quantity,
        unit_price=product.price,
        name=product.name,
    )
    # A fresh, uniquely-IDed cart per call (see app/state.py: create_cart
    # generates a new uuid4 cart_id and stores it under a lock) is how
    # concurrent, independent callers stay isolated from each other today
    # -- there is no shared/global cart.
    cart = create_cart([item])
    return CartResponse(cart_id=cart.cart_id, items=cart.items, total=cart.total)
