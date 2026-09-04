# Performance Evaluator — Canonical Demo API

Controlled e-commerce HTTP target for autonomous performance evaluation. This service is the **experimental subject** — not part of the evaluator backend, k6 engine, or planner.

## What this is

A small FastAPI application with deterministic in-memory data and four runtime performance modes. Dev-1's evaluator and Dev-2's k6 engine target this API via normal HTTP using `base_url` and the OpenAPI document.

## Directory structure

```
demo-api/
├── app/
│   ├── main.py          # FastAPI application
│   ├── config.py        # Environment configuration
│   ├── models.py        # Pydantic request/response schemas
│   ├── data.py          # Deterministic sample products
│   ├── state.py         # Thread-safe mode and cart state
│   ├── modes.py         # Error injection helper
│   └── routes/          # HTTP route handlers
├── tests/               # pytest suite
├── scripts/             # Manual k6 scripts
├── requirements.txt
├── run.py               # Startup entrypoint
└── README.md
```

## Installation

```bash
cd demo-api
pip install -r requirements.txt
```

## Startup

```bash
python run.py
```

Default base URL: **http://127.0.0.1:8080**

## OpenAPI

| URL | Description |
|---|---|
| http://127.0.0.1:8080/openapi.json | Machine-readable OpenAPI 3 spec |
| http://127.0.0.1:8080/docs | Swagger UI |

## Demo credentials

| Field | Value |
|---|---|
| username | `demo` |
| password | `demo123` |

Returns a static demo token (no real JWT/OAuth).

## Runtime modes

| Mode | Behavior |
|---|---|
| `normal` | No artificial delay or injected failures |
| `db_latency` | ~150 ms delay on `GET /products` and `GET /products/{id}` |
| `checkout_bottleneck` | ~800 ms delay on `POST /checkout` only |
| `error_injection` | ~30% of requests return HTTP 503 |

Switch mode at runtime (no restart required):

```bash
curl -X POST http://127.0.0.1:8080/demo/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"checkout_bottleneck"}'
```

Check current mode:

```bash
curl http://127.0.0.1:8080/demo/mode
```

## Example curl calls

```bash
# Login
curl -X POST http://127.0.0.1:8080/login \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demo123"}'

# List products
curl http://127.0.0.1:8080/products

# Get product
curl http://127.0.0.1:8080/products/1

# Add to cart
curl -X POST http://127.0.0.1:8080/cart \
  -H "Content-Type: application/json" \
  -d '{"product_id":1,"quantity":1}'

# Checkout (use cart_id from previous response)
curl -X POST http://127.0.0.1:8080/checkout \
  -H "Content-Type: application/json" \
  -d '{"cart_id":"<cart_id>"}'
```

## Running tests

```bash
cd demo-api
pytest -v
```

Tests reset shared runtime mode/state between cases.

## Manual k6

Start the API, set mode, then run:

```bash
# Normal mode
curl -X POST http://127.0.0.1:8080/demo/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"normal"}'
k6 run scripts/k6_products.js

# Error injection
curl -X POST http://127.0.0.1:8080/demo/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"error_injection"}'
k6 run scripts/k6_products.js

# Checkout bottleneck (POST checkout flow)
curl -X POST http://127.0.0.1:8080/demo/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"checkout_bottleneck"}'
k6 run scripts/k6_checkout.js
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8080` | Bind port |
| `DB_LATENCY_MS` | `150` | Product read delay in `db_latency` mode |
| `CHECKOUT_DELAY_MS` | `800` | Checkout delay in `checkout_bottleneck` mode |
| `ERROR_INJECTION_FAIL_PERCENT` | `30` | Approximate 503 rate in `error_injection` mode |
| `DEMO_USERNAME` | `demo` | Login username |
| `DEMO_PASSWORD` | `demo123` | Login password |
| `DEMO_TOKEN` | `demo-token-static` | Token returned on successful login |

## Important limitation

All product and cart data is **in-memory**. Restarting the process resets carts and returns mode to `normal`. This is intentional for reproducible demo behavior.

## Integration with evaluator

Point Dev-1's backend at:

```json
{
  "target": {
    "base_url": "http://127.0.0.1:8080"
  }
}
```

No evaluator-specific endpoints exist on this API.
