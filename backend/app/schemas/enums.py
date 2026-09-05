from enum import Enum


class ObjectiveType(str, Enum):
    boundary_search = "boundary_search"
    fixed_load = "fixed_load"


class TestType(str, Enum):
    baseline = "baseline"
    soak = "soak"
    stress = "stress"


class RunState(str, Enum):
    """Execution lifecycle state. Never mixed with performance PASS/FAIL."""

    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    EXECUTION_ERROR = "EXECUTION_ERROR"


class ResultClassification(str, Enum):
    """Performance outcome. Only produced by deterministic threshold evaluation."""

    PASS = "PASS"
    FAIL = "FAIL"


class IntentStatus(str, Enum):
    """Outcome of compiling a UniversalPerformanceIntent. Never produced by
    an LLM -- computed deterministically by app/services/intent_compiler.py.
    See backend/docs/ai_intent_architecture.md."""

    READY = "READY"
    NEEDS_CLARIFICATION = "NEEDS_CLARIFICATION"
    INVALID = "INVALID"
