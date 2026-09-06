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


class PayloadStrategy(str, Enum):
    """Deterministic request-body generation strategy (Session 3) --
    app/services/k6_engine/payload_generator.py. Not a fuzzing framework:
    exactly two fixed, reproducible strategies, chosen from a TestPlan
    field, never from randomness or an LLM at generation time.

    normal    -- the pre-existing, unchanged behavior: a schema-valid
                 representative value for each field (fixed defaults,
                 or the schema's own example/default/enum[0] when given).
    boundary  -- pushes each generated value to the nearest schema-declared
                 edge (maximum/minimum, maxLength/minLength, maxItems/
                 minItems, or the LAST enum value instead of the first),
                 falling back to the exact same `normal` value for any
                 field with no edge to push toward (e.g. a plain boolean,
                 or a string/number with no length/range constraint at
                 all). See payload_generator.py for the exact per-type
                 rule."""

    normal = "normal"
    boundary = "boundary"


class Severity(str, Enum):
    """AI result-analysis severity (final session) --
    app/schemas/test_result.py::AIAnalysis. A closed, small set so the
    frontend can render it consistently (e.g. a fixed color per level)
    without guessing at free-form text the model might otherwise emit."""

    none = "none"
    low = "low"
    medium = "medium"
    high = "high"


class Confidence(str, Enum):
    """How much the AI analyzer itself trusts its own summary/findings --
    NOT a measure of the underlying evidence's quality (the evidence is
    either present or it isn't; see FailureLocalization/Statistics, both
    always deterministic). Advisory only, same spirit as
    app/schemas/intent.py::ConfidenceInfo -- never read by any
    deterministic code path to make a decision."""

    low = "low"
    medium = "medium"
    high = "high"
