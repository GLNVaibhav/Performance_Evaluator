# Target API (demo-api) Architecture Notes

**Status: review + additive expansion, no execution-core changes applied.**
Companion to `backend/docs/workflow_contract.md`. Written from direct
inspection of `demo-api/` and `backend/app/services/k6_engine/*`, and from
real k6 executions against the running demo API -- not from assumption.

## 1. What the demo API actually is (verified)

FastAPI app (`demo-api/app/main.py`), in-memory state only (no database,
no persistence across process restarts), single process. Before this
review: `/login`, `/products`, `/products/{product_id}`, `/cart`,
`/checkout`, `/health`, `/demo/mode`. Cart state lives in
`app/state.py::_carts: Dict[str, Cart]`, a plain module-level dict
protected by a single `threading.Lock()` on every read and write
(`create_cart`, `get_cart`) -- confirmed thread-safe for concurrent
mutation by inspection, and now also empirically (see §4).

## 2. Findings against the Phase 2 questions

| Question | Finding |
|---|---|
| Is state persistent or in-memory? | In-memory only; a restart clears all carts/orders. |
| Safe under concurrent access? | Yes for the existing `_carts` dict (lock-protected reads/writes) -- confirmed both by code inspection and a new concurrency test (§4). |
| Does checkout depend on cart state? | Yes -- `POST /checkout` requires a real, prior `cart_id`; `demo-api/app/routes/checkout.py` 404s otherwise. |
| Can multiple users independently interact? | Yes, at the HTTP-call level: every `POST /cart` creates a brand-new cart with a fresh `uuid4` id -- there is no shared/global cart to collide on. |
| Are resources user-scoped? | No explicit "user" concept exists (no session, no auth-derived identity) -- isolation today is per-*cart*, not per-authenticated-user (see §5). |
| Can concurrent k6 VUs mutate shared state safely? | Yes for the cart-creation pattern already in use -- proven under real concurrent HTTP load, not just reasoning (§4, §6). |
| Does the OpenAPI surface accurately represent the API? | Yes, including after this review's additions -- verified live against the running server's `/openapi.json` (§3). |

## 3. OpenAPI verification (live, not assumed)

```
GET /openapi.json paths (after this review's changes):
['/login', '/products', '/products/{product_id}', '/categories',
 '/categories/{category_id}', '/cart', '/checkout', '/health', '/demo/mode']
```

`/products/{product_id}` and `/categories/{category_id}` are real path
*templates* with a discoverable `category_id`/`product_id` path parameter
-- confirmed both by reading the live spec and by a new contract test
(`demo-api/tests/test_openapi.py::test_categories_endpoints_have_get_methods_in_openapi`).
This matters because the Performance Evaluator's endpoint resolver
(`backend/app/services/k6_engine/endpoint_resolver.py`) matches
`selected_endpoints` against these exact path templates, not against
instantiated example paths -- confirmed (and already independently
demonstrated in the prior workflow review) that a literal path like
`/products/1` does **not** match `/products/{product_id}` and fails at
execution time even though it compiles `READY`.

## 4. Concurrency: what was proven, not assumed

`demo-api/tests/test_endpoints.py` gained two tests using real concurrent
requests (`asyncio.gather` against the same in-process ASGI app, i.e. the
same code path and the same lock a live server under concurrent k6 VUs
would exercise):

- `test_concurrent_carts_do_not_corrupt_or_mix_state` -- 40 concurrent
  `POST /cart` calls, asserts every `cart_id` is unique and every
  response's items belong to exactly that caller.
- `test_concurrent_users_can_independently_checkout_without_cross_contamination`
  -- 20 concurrent full create-cart-then-checkout flows, asserts every
  `order_id` and `cart_id` is unique (no pairing mix-up under load).

Both pass. Separately, the real k6 vertical-slice test
(`backend/tests/test_ecommerce_target_workload.py`) ran 15 concurrent VUs
against the live server for 10s (397 real HTTP requests) with **0%**
error rate, including 44 real `/checkout` calls each depending on its own
iteration's `/cart` call -- concurrent, dependent, real.

## 5. Authentication / identity decision -- verified, not assumed

`grep`-confirmed against `backend/app/services/k6_engine/script_renderer.py`:
the **only** header the k6 engine ever emits is a hardcoded
`Content-Type: application/json`. There is no mechanism for dynamic
Authorization headers, tokens, cookies, or any other per-request
configurable header.

**Decision: no authentication system was added**, not even the
lightweight `X-Test-User-ID` header option the review brief offered,
because it has the identical root blocker -- there is nowhere in the
engine to attach it per request without modifying
`script_renderer.py` (execution-core, not touched in this review).
`/login` remains present and untouched; it stays honestly
un-exercisable by the Performance Evaluator today, which is a
pre-existing limitation, not one introduced here.

**"Independent logical users" is instead proven the way the engine
already supports it**: every `POST /cart` call is a fresh, uniquely-IDed,
lock-protected resource creation, entirely independent of any caller
identity concept. This is not a workaround -- it is the honest current
capability, documented rather than papered over with an
unexercisable auth layer.

## 6. Genuine blocker found and documented (Phase 8 format)

**1. Exact file:** `backend/app/services/k6_engine/payload_generator.py`
(`generate_value`), root-caused to
`backend/app/services/k6_engine/openapi_loader.py`
(`_resolve_request_schema` / `_resolve_ref`).

**2. Exact limitation:** `openapi_loader._resolve_request_schema` resolves
a `$ref` only at the *top level* of a request body schema. It does not
recursively resolve a `$ref` that appears *nested* inside that schema --
e.g. inside an array's `items`, which is exactly what FastAPI/Pydantic
emits for a field typed `List[SomeNestedModel]`.
`payload_generator.generate_value` has no `$ref` branch at all, so a
nested-model list falls through to `UnsupportedSchemaError`.

**3. Why the target expansion cannot proceed (for this specific shape)
without modification:** a multi-item cart (`items: List[CartItemRequest]`)
is the natural, idiomatic way to model "one resource has many related
sub-resources" -- exactly the "resource relationships" this whole review
was asked to demonstrate. It was implemented, and **empirically failed a
real k6 execution**:
```
could not prepare k6 script: no generation rule for schema type: None
({'$ref': '#/components/schemas/CartItemRequest'})
```
This is not a hypothetical edge case; it is the standard shape any
realistic nested-resource domain model produces.

**4. Minimal proposed change (not applied):** add a small, recursive
`$ref`-resolution pass inside `openapi_loader._resolve_request_schema`
(or a new private helper it calls) that walks the resolved schema tree
--`properties` values and array `items` -- and replaces any nested
`{"$ref": ...}` node with its resolved target, so that
`payload_generator.py` always receives a fully-dereferenced tree and
needs **no changes at all** (it already assumes no `$ref` survives to
that point; this closes that assumption's one gap). Scope: one new
private helper plus one call-site change, in one file
(`openapi_loader.py`); zero changes to `payload_generator.py`,
`script_renderer.py`, `engine.py`, or any public function signature.

**5. Alternatives considered:**
- *Apply the fix now.* Rejected for this review: `k6_engine/*` has been
  explicitly protected across multiple prior review passes ("do not
  modify unless a blocker is proven"); a blocker *is* now proven, but
  applying an execution-core fix should be an explicit, separately
  reviewed decision, not bundled into a target-API expansion task.
- *Avoid `$ref` by inlining the item type as a raw `dict`/`Dict[str,int]`
  instead of a named Pydantic model.* Rejected: this is a non-idiomatic
  schema shape purely to dodge a tooling gap -- worse for realism than
  the single-item schema it would replace, and would misrepresent what a
  "realistic" domain model actually looks like.
- **Chosen for this review: revert to the original single-item
  `product_id`/`quantity` cart schema** (already proven working, zero
  risk), and document this finding for an explicit follow-up decision.
  This keeps the review's deliverable genuinely working and honestly
  scoped rather than silently degrading the feature or bundling an
  unreviewed execution-core change.

## 7. Deliberately not implemented, and why

- **Nested-model multi-item cart** -- blocked by the finding in §6;
  reverted to the proven single-item schema.
- **`GET /cart/{cart_id}` (view an existing cart) / `DELETE
  /cart/items/{item_id}`** -- not added. The engine's only cross-request
  data-threading mechanism is the existing hardcoded response-body ->
  request-*body* substitution used for checkout<-cart, scoped to that one
  pair. There is no mechanism to thread a dynamically-created id into a
  *separately selected* endpoint's *path* parameter. Adding such
  endpoints without that mechanism would mean every VU addresses the same
  static example path value -- not a meaningful exercise of the
  endpoint, and not the honest "independent users" story this review
  set out to prove.
- **`GET /orders/{order_id}`** -- same reason: `order_id` is only known
  from a `POST /checkout` response, and there is no third-call threading
  mechanism for it today.
- **JWT / session authentication** -- see §5.
- **Redis/PostgreSQL/Docker** -- inspection found no requirement for
  them: the existing in-memory, lock-protected dict already provides
  correct, proven concurrent isolation for the resource-creation pattern
  the engine can actually exercise. Adding external infrastructure would
  be speculative, contradicting the "keep it lightweight" brief.
