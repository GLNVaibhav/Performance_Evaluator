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
