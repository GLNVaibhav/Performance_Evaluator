from fastapi import APIRouter, HTTPException, status

from app.data import PRODUCTS, PRODUCTS_BY_ID
from app.models import ErrorResponse, Product, ProductListResponse
from app.modes import maybe_fail_request
from app.state import apply_db_latency

router = APIRouter(tags=["products"])


@router.get(
    "/products",
    response_model=ProductListResponse,
    status_code=status.HTTP_200_OK,
    responses={status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ErrorResponse}},
)
async def list_products() -> ProductListResponse:
    await maybe_fail_request()
    await apply_db_latency()
    return ProductListResponse(products=PRODUCTS)


@router.get(
    "/products/{product_id}",
    response_model=Product,
    status_code=status.HTTP_200_OK,
    responses={
        status.HTTP_404_NOT_FOUND: {"model": ErrorResponse},
        status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ErrorResponse},
    },
)
async def get_product(product_id: int) -> Product:
    await maybe_fail_request()
    await apply_db_latency()
    product = PRODUCTS_BY_ID.get(product_id)
    if product is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Product {product_id} not found",
        )
    return product
