"""Integration boundary with the performance engine (owned by Developer 2).

This module defines the CONTRACT only. The backend depends on this
Protocol, never on a concrete renderer/runner/metrics implementation.
Developer 2's real engine (k6 script templating, payload generation,
subprocess execution, metrics analysis from k6's --summary-export -- the
frozen MVP result artifact, see performance_engine_interface.md) must
implement `PerformanceEngine` and nothing else needs to change in
run_service.py.

Full contract writeup: backend/docs/performance_engine_interface.md
"""

from pathlib import Path
from typing import Protocol

from app.schemas.test_plan import TargetConfig, TestPlan
from app.schemas.test_result import EngineExecutionOutcome


class PerformanceEngine(Protocol):
    def execute(
        self,
        plan: TestPlan,
        target: TargetConfig,
        artifact_directory: Path,
    ) -> EngineExecutionOutcome:
        """Render + run the plan against target, return the outcome.

        Must NOT raise for a legitimate performance failure (thresholds not
        met) -- that is expressed via `threshold_status=FAIL` with
        `summary_exists=True`. Raising (or returning `summary_exists=False`
        with `error_message` set) is reserved for actual execution failure
        (script/runtime error, target unreachable, timeout, etc.).
        """
        ...
