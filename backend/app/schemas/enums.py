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
