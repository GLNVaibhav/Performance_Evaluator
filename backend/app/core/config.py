from pathlib import Path
import os

BACKEND_ROOT = Path(__file__).resolve().parents[2]

# Root directory where per-run artifacts (rendered scripts, k6 summary/raw
# output, stdout/stderr logs) are written. One subdirectory per run_id.
ARTIFACTS_DIR = Path(os.environ.get("ARTIFACTS_DIR", BACKEND_ROOT / "artifacts")).resolve()

# SQLite database file.
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{(BACKEND_ROOT / 'app.db').resolve()}")

# Path (or bare command, if on PATH) to the k6 binary. Kept configurable
# because it is not guaranteed to be on PATH on every dev machine/CI runner.
K6_BINARY = os.environ.get("K6_BINARY", "k6")

# Hardcoded TestPlan directory for Phase 1 (no LLM planner yet).
DEMO_PLANS_DIR = Path(os.environ.get("DEMO_PLANS_DIR", BACKEND_ROOT / "demo_plans")).resolve()

# Wall-clock ceiling on a single k6 subprocess execution ("MAX_EXECUTION_
# TIMEOUT"). This is a process safety net -- it protects against a hung k6
# process. It is NOT the same control as MAX_DURATION_S below (that limits
# the *planned* workload; this limits how long we'll wait for the process).
# Must stay comfortably above MAX_DURATION_S to leave room for k6 startup,
# ramp-up, and teardown, or legitimate runs would be misclassified as
# execution failures on timeout.
K6_EXECUTION_TIMEOUT_S = int(os.environ.get("K6_EXECUTION_TIMEOUT_S", "120"))

# Authoritative, server-side workload safety limits. Enforced in
# app/services/workload_limits.py before a plan is persisted or executed --
# never left to k6 or the subprocess timeout to fail safely. MVP targets
# are local/staging/sandbox only, never production, so these are sized for
# a single developer machine running one run at a time, not a load-testing
# fleet.
MAX_VUS = int(os.environ.get("MAX_VUS", "2000"))
MAX_DURATION_S = int(os.environ.get("MAX_DURATION_S", "90"))

# LLM intent interpreter (app/services/llm_intent_interpreter.py). OpenAI-
# compatible chat-completions API: works unmodified against OpenAI itself
# and any compatible provider (Groq, OpenRouter, a local server, etc.) by
# pointing LLM_BASE_URL at it -- no per-provider SDK, no extra dependency
# (uses httpx, already required). LLM_API_KEY has no default on purpose --
# never commit a key, never silently fall back to a hardcoded one.
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1")
LLM_TIMEOUT_S = float(os.environ.get("LLM_TIMEOUT_S", "20"))

# Known endpoints the demo target actually exposes (verified live against
# demo-api's /openapi.json during the target-validation review -- not
# invented). Given to LLMIntentInterpreter as the closed set it must pick
# target_scope.endpoints from; overridable via env for a different target
# without a code change.
LLM_KNOWN_ENDPOINTS = [
    e.strip()
    for e in os.environ.get(
        "LLM_KNOWN_ENDPOINTS",
        "/products,/products/{product_id},/categories,/categories/{category_id},/cart,/checkout",
    ).split(",")
    if e.strip()
]

ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

# SSRF policy for user-supplied target/OpenAPI URLs (app/services/
# target_url_safety.py). "allow_private" (default) permits loopback/
# private-network hosts -- required for this project's own local/demo
# workflow (the canonical demo API runs at 127.0.0.1, and the documented
# MVP scope is "local/staging/sandbox only", never production -- see
# docs/performance_engine_interface.md). "block_private" additionally
# rejects loopback/private/link-local hosts, for a deployment where the
# backend itself is reachable from outside and a stricter policy is
# wanted. Cloud-metadata / link-local addresses (169.254.0.0/16, incl. the
# common 169.254.169.254 metadata IP, and Alibaba Cloud's
# 100.100.100.200) are ALWAYS blocked regardless of this setting -- there
# is no legitimate performance-test target in that range.
TARGET_SSRF_POLICY = os.environ.get("TARGET_SSRF_POLICY", "allow_private")

# Cap on a fetched OpenAPI document's size (app/services/k6_engine/
# openapi_loader.py). Hackathon-grade, not a true streaming cap (httpx.get
# already fully downloads the response before this check runs) -- see
# that module's docstring for the accepted tradeoff.
MAX_OPENAPI_DOC_BYTES = int(os.environ.get("MAX_OPENAPI_DOC_BYTES", str(5 * 1024 * 1024)))  # 5 MiB

# --- Payload generation safety (Session 3) ---------------------------------
# app/services/k6_engine/payload_generator.py. Since Session 1 opened
# OpenAPI *discovery* to an arbitrary user-supplied URL, a schema is no
# longer necessarily authored by this project's own team -- these bound
# what a maliciously or accidentally pathological schema (deeply nested
# inline objects/arrays, no $ref cycle needed) can make the generator do.
# Not workload limits (those are app/services/workload_limits.py, about
# VUs/duration) -- these are about the SHAPE of one generated request body.

# Recursion depth ceiling while walking a request-body schema tree
# (properties / array items nested arbitrarily). Comfortably above any
# realistic real-world schema (the canonical demo API's deepest schema is
# 2 levels) while still bounding a pathological/adversarial one.
MAX_PAYLOAD_DEPTH = int(os.environ.get("MAX_PAYLOAD_DEPTH", "12"))

# Max number of items generated for one array field, regardless of the
# schema's own `maxItems` (a schema-declared `minItems` is still honored,
# capped at this ceiling).
MAX_PAYLOAD_ARRAY_ITEMS = int(os.environ.get("MAX_PAYLOAD_ARRAY_ITEMS", "20"))

# Max serialized (JSON) size of one generated request body.
MAX_PAYLOAD_BODY_BYTES = int(os.environ.get("MAX_PAYLOAD_BODY_BYTES", str(64 * 1024)))  # 64 KiB

# Same depth ceiling, applied independently inside app/services/k6_engine/
# openapi_loader.py's nested-$ref resolution pass (Session 3) -- bounds a
# very long (but acyclic) $ref chain in a user-supplied OpenAPI document.
# A *cyclic* $ref chain (a legitimate recursive-type shape, e.g. a
# tree/linked-list schema) is separately detected and never expanded more
# than once, regardless of this constant.
MAX_REF_RESOLUTION_DEPTH = int(os.environ.get("MAX_REF_RESOLUTION_DEPTH", "20"))

# Browser-facing CORS allow-list (app/main.py). The frontend
# (clone/performance-evaluator-frontend) runs on a different origin
# (Vite's dev server, http://localhost:5173 by default) than this backend
# (http://127.0.0.1:8000) -- without an explicit allow-list, a browser
# blocks the cross-origin request at the CORS preflight stage (confirmed:
# `OPTIONS .../intents/interpret` with a real `Origin` header returned
# `405` with no `Access-Control-*` headers before this was added), which
# surfaces in the frontend as a generic "network error contacting
# backend" -- indistinguishable, from the browser's own error, from an
# actual unreachable server. Explicit origins only, never `"*"` (this
# project's own convention throughout -- e.g. TARGET_SSRF_POLICY,
# LLM_KNOWN_ENDPOINTS -- is "explicit allow-list, env-configurable,
# never a wildcard"). `127.0.0.1` and `localhost` are listed separately
# because browsers treat them as distinct origins even though they
# resolve to the same host.
CORS_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if o.strip()
]
