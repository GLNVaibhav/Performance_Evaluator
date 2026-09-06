"""Session 6 demo CLI: submits a run to the EXISTING API
(POST /api/v1/runs, GET /api/v1/runs/{id}, GET /api/v1/runs/{id}/result --
all pre-existing, unmodified by this session), polls it to a terminal
state, and prints the presentation layer's formatted report
(app/presentation/terminal_report.py).

This script is pure I/O glue -- httpx calls + polling + printing. It
contains NO formatting logic and NO statistics computation of its own;
every displayed number comes from the API's existing JSON responses,
parsed back into the same Pydantic models the API itself uses
(app.schemas.test_plan.TestPlan, app.schemas.test_result.TestResult),
then handed to terminal_report.py exactly as a real client would.

Usage (from the backend/ directory, backend already running):

    python scripts/run_demo.py
    python scripts/run_demo.py --plan-id boundary_search_checkout --target http://127.0.0.1:8080
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_BACKEND_ROOT))

import httpx  # noqa: E402
from pydantic import TypeAdapter  # noqa: E402

from app.presentation.terminal_report import render_completed_report, render_header  # noqa: E402
from app.schemas.enums import RunState  # noqa: E402
from app.schemas.test_plan import TestPlan  # noqa: E402
from app.schemas.test_result import TestResult  # noqa: E402

_DEMO_PLANS_DIR = _BACKEND_ROOT / "demo_plans"


def _load_plan_for_display(plan_id: str) -> TestPlan | None:
    """Reads the same hardcoded plan file run_service._load_hardcoded_plan()
    would -- purely so this script can render the workload header locally
    without a new API capability. Returns None if unavailable; the header
    then just shows "N/A" for workload (see render_header)."""
    path = _DEMO_PLANS_DIR / f"{plan_id}.json"
    if not path.exists():
        return None
    return TypeAdapter(TestPlan).validate_python(json.loads(path.read_text()))


def main() -> int:
    parser = argparse.ArgumentParser(description="Submit a run and print its terminal report.")
    parser.add_argument("--backend", default="http://127.0.0.1:8000", help="Backend base URL")
    parser.add_argument("--plan-id", default="baseline_checkout", help="Hardcoded demo_plans/<id>.json to run")
    parser.add_argument("--target", default="http://127.0.0.1:8080", help="Target base_url (the demo API)")
    parser.add_argument("--poll-interval", type=float, default=1.0)
    parser.add_argument("--timeout", type=float, default=60.0, help="Max seconds to wait for a terminal state")
    args = parser.parse_args()

    plan = _load_plan_for_display(args.plan_id)

    client = httpx.Client(timeout=10.0)
    create_resp = client.post(
        f"{args.backend}/api/v1/runs", json={"plan_id": args.plan_id, "target": {"base_url": args.target}}
    )
    if create_resp.status_code != 201:
        print(f"Failed to create run: HTTP {create_resp.status_code} {create_resp.text}")
        return 1
    run_id = create_resp.json()["run_id"]

    print(render_header(target_base_url=args.target, plan=plan, state=RunState.QUEUED))
    print()

    deadline = time.monotonic() + args.timeout
    state = RunState.QUEUED
    error_message = None
    while time.monotonic() < deadline:
        status_resp = client.get(f"{args.backend}/api/v1/runs/{run_id}")
        status_body = status_resp.json()
        state = RunState(status_body["status"])
        error_message = status_body.get("error_message")
        if state in (RunState.COMPLETED, RunState.EXECUTION_ERROR, RunState.CANCELLED):
            break
        time.sleep(args.poll_interval)

    if state == RunState.COMPLETED:
        result_resp = client.get(f"{args.backend}/api/v1/runs/{run_id}/result")
        result = TestResult.model_validate(result_resp.json())
        print(render_completed_report(result))
    else:
        print(render_header(target_base_url=args.target, plan=plan, state=state, error_message=error_message))

    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
