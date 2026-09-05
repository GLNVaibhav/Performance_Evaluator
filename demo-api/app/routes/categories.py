from fastapi import APIRouter, HTTPException, status

from app.data import CATEGORIES, CATEGORIES_BY_ID
from app.models import Category, CategoryListResponse, ErrorResponse
from app.modes import maybe_fail_request
from app.state import apply_db_latency

router = APIRouter(tags=["categories"])


@router.get(
    "/categories",
    response_model=CategoryListResponse,
    status_code=status.HTTP_200_OK,
    responses={status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ErrorResponse}},
)
async def list_categories() -> CategoryListResponse:
    await maybe_fail_request()
    await apply_db_latency()
    return CategoryListResponse(categories=CATEGORIES)


@router.get(
    "/categories/{category_id}",
    response_model=Category,
    status_code=status.HTTP_200_OK,
    responses={
        status.HTTP_404_NOT_FOUND: {"model": ErrorResponse},
        status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ErrorResponse},
    },
)
async def get_category(category_id: int) -> Category:
    await maybe_fail_request()
    await apply_db_latency()
    category = CATEGORIES_BY_ID.get(category_id)
    if category is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Category {category_id} not found",
        )
    return category
