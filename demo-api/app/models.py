from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field, PositiveInt


class DemoMode(str, Enum):
    normal = "normal"
    db_latency = "db_latency"
    checkout_bottleneck = "checkout_bottleneck"
    error_injection = "error_injection"


class Product(BaseModel):
    id: int
    name: str
    price: float = Field(ge=0)
    category: str
    inventory: int = Field(ge=0)


class ProductListResponse(BaseModel):
    products: List[Product]


class Category(BaseModel):
    id: int
    name: str
    description: str


class CategoryListResponse(BaseModel):
    categories: List[Category]


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    username: str


class CartItem(BaseModel):
    product_id: int
    quantity: PositiveInt
    unit_price: float = Field(ge=0)
    name: str


class CartRequest(BaseModel):
    # Deliberately kept single-item / flat-field (product_id, quantity),
    # NOT items: List[CartItemRequest]. A nested-model list was tried
    # during this expansion and empirically failed real k6 execution: the
    # Performance Evaluator's payload_generator.py does not resolve a
    # $ref that appears NESTED inside a schema (e.g. an array's `items`
    # pointing at another component schema) -- only the top-level request
    # body $ref is resolved (app/services/k6_engine/openapi_loader.py).
    # This is a genuine, proven engine limitation, not a demo-api design
    # choice -- see backend/docs/target_api_notes.md for the full finding,
    # root cause, and proposed minimal fix. Reverted here rather than
    # patching protected execution-core code without explicit approval.
    product_id: int
    quantity: PositiveInt = 1


class CartResponse(BaseModel):
    cart_id: str
    items: List[CartItem]
    total: float = Field(ge=0)


class CheckoutRequest(BaseModel):
    cart_id: str


class OrderResponse(BaseModel):
    order_id: str
    cart_id: str
    status: str
    total: float = Field(ge=0)


class ModeRequest(BaseModel):
    mode: DemoMode


class ModeResponse(BaseModel):
    mode: DemoMode
    message: str


class HealthResponse(BaseModel):
    status: str
    mode: DemoMode


class ErrorResponse(BaseModel):
    detail: str
