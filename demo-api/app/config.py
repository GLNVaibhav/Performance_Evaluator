import os

HOST: str = os.getenv("HOST", "127.0.0.1")
PORT: int = int(os.getenv("PORT", "8080"))

DB_LATENCY_MS: int = int(os.getenv("DB_LATENCY_MS", "150"))
CHECKOUT_DELAY_MS: int = int(os.getenv("CHECKOUT_DELAY_MS", "800"))
ERROR_INJECTION_FAIL_PERCENT: int = int(os.getenv("ERROR_INJECTION_FAIL_PERCENT", "30"))

DEMO_USERNAME: str = os.getenv("DEMO_USERNAME", "demo")
DEMO_PASSWORD: str = os.getenv("DEMO_PASSWORD", "demo123")
DEMO_TOKEN: str = os.getenv("DEMO_TOKEN", "demo-token-static")


def _validate_percent(name: str, value: int) -> None:
    if not 0 <= value <= 100:
        raise ValueError(f"{name} must be between 0 and 100, got {value}")


def _validate_non_negative_ms(name: str, value: int) -> None:
    if value < 0:
        raise ValueError(f"{name} must be non-negative, got {value}")


_validate_non_negative_ms("DB_LATENCY_MS", DB_LATENCY_MS)
_validate_non_negative_ms("CHECKOUT_DELAY_MS", CHECKOUT_DELAY_MS)
_validate_percent("ERROR_INJECTION_FAIL_PERCENT", ERROR_INJECTION_FAIL_PERCENT)
