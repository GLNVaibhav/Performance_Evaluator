import asyncio
import itertools
import threading
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from app.config import (
    CHECKOUT_DELAY_MS,
    DB_LATENCY_MS,
    ERROR_INJECTION_FAIL_PERCENT,
)
from app.models import CartItem, DemoMode


@dataclass
class Cart:
    cart_id: str
    items: List[CartItem] = field(default_factory=list)

    @property
    def total(self) -> float:
        return round(sum(item.unit_price * item.quantity for item in self.items), 2)


_lock = threading.Lock()
_current_mode = DemoMode.normal
_request_counter = itertools.count(1)
_carts: Dict[str, Cart] = {}


def get_mode() -> DemoMode:
    with _lock:
        return _current_mode


def set_mode(mode: DemoMode) -> DemoMode:
    global _current_mode
    with _lock:
        _current_mode = mode
    return mode


def reset_runtime_state() -> None:
    """Reset shared runtime state (used by tests)."""
    global _current_mode, _carts
    with _lock:
        _current_mode = DemoMode.normal
        _carts = {}


def next_request_id() -> int:
    with _lock:
        return next(_request_counter)


def should_inject_error() -> bool:
    request_id = next_request_id()
    bucket = (request_id * 2654435761) % 100
    return bucket < ERROR_INJECTION_FAIL_PERCENT


async def apply_db_latency() -> None:
    if get_mode() == DemoMode.db_latency and DB_LATENCY_MS > 0:
        await asyncio.sleep(DB_LATENCY_MS / 1000.0)


async def apply_checkout_delay() -> None:
    if get_mode() == DemoMode.checkout_bottleneck and CHECKOUT_DELAY_MS > 0:
        await asyncio.sleep(CHECKOUT_DELAY_MS / 1000.0)


def create_cart(items: List[CartItem]) -> Cart:
    cart = Cart(cart_id=str(uuid.uuid4()), items=items)
    with _lock:
        _carts[cart.cart_id] = cart
    return cart


def get_cart(cart_id: str) -> Optional[Cart]:
    with _lock:
        return _carts.get(cart_id)
