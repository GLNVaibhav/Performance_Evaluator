## Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/login` | Demo login (`demo` / `demo123`) |
| GET | `/products` | List all products |
| GET | `/products/{id}` | Get product by ID |
| POST | `/cart` | Add item to cart |
| POST | `/checkout` | Complete checkout for a cart |
| POST | `/demo/mode` | Switch runtime performance mode |
| GET | `/demo/mode` | Read current mode |
| GET | `/health` | Health + current mode |

## OpenAPI

- `GET /openapi.json` — valid OpenAPI 3.x spec
- `GET /docs` — Swagger UI
- POST bodies for `/login`, `/cart`, `/checkout`, `/demo/mode` are fully typed via Pydantic models
- No evaluator-specific endpoints (`/generate-k6`, etc.)

## Runtime modes

| Mode | Effect |
|---|---|
| `normal` | No artificial delay or failures |
| `db_latency` | ~150 ms delay on `GET /products`, `GET /products/{id}` |
| `checkout_bottleneck` | ~800 ms delay on `POST /checkout` only |
| `error_injection` | ~30% requests return HTTP 503 |

Mode switching is runtime (no restart). Invalid modes return HTTP 422.

## Startup

```bash
cd demo-api
pip install -r requirements.txt
python run.py
```

Base URL: `http://127.0.0.1:8080`

## Testing

```
17 passed in 1.06s
```

```bash
cd demo-api && pytest -v
```

## Manual k6 evidence

Scripts: `demo-api/scripts/k6_products.js`, `demo-api/scripts/k6_checkout.js`

| Mode | Script | p95 latency | Error rate |
|---|---|---|---|
| `normal` | `k6_products.js` (10 VUs, 15s) | **11.85 ms** | **0.00%** |
| `error_injection` | `k6_products.js` (10 VUs, 15s) | **15.39 ms** | **30.02%** |
| `checkout_bottleneck` | `k6_checkout.js` (5 VUs, 10s) | **825.75 ms** | **0.00%** |

Raw summaries committed under `demo-api/tools/k6_*_summary*.json`.

## Configuration

| Variable | Default |
|---|---|
| `HOST` | `127.0.0.1` |
| `PORT` | `8080` |
| `DB_LATENCY_MS` | `150` |
| `CHECKOUT_DELAY_MS` | `800` |
| `ERROR_INJECTION_FAIL_PERCENT` | `30` |

## Integration notes

- Dev-1: target via `{ "target": { "base_url": "http://127.0.0.1:8080" } }`
- Dev-2: OpenAPI at `/openapi.json` describes all POST request bodies; real engine should use declared HTTP methods (not GET-only)
- Set mode via `POST /demo/mode` before each independent k6 experiment in boundary-search sequences

## Known limitations

- In-memory data only; restart resets carts and mode to `normal`
- Demo auth is fake (static token, no JWT)
- Reference k6 engine (Dev-1 PR #1) is GET-only — use manual POST k6 script for checkout bottleneck proof until Dev-2 engine lands
