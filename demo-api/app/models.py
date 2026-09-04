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
