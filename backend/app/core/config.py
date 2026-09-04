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

ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
