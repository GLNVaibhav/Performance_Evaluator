"""IntentInterpreter: the provider-agnostic boundary that any future NLP/LLM
implementation must respect.

Mirrors the existing PerformanceEngine convention
(app/services/performance_engine.py): the rest of the system depends only
on this Protocol, never on a concrete implementation. No real NLP or LLM
provider is implemented here or anywhere else in this repository yet --
this module exists to establish and test the SEAM future intelligence will
be forced to respect, not to build that intelligence.

ABSOLUTE RULE: an IntentInterpreter produces ONLY an InterpretationResult
-- structured interpretation data, nothing else. It must never:

  - execute k6, or call PerformanceEngine / RunService,
  - generate k6 scripts,
  - persist a run,
  - make a network call,
  - construct a TestPlan directly (as an alternate authority) or bypass
    compile_intent(),
  - modify execution behavior in any way.

The only allowed path onward from an InterpretationResult is:

    result.intent (if any)
        -> app.services.intent_compiler.compile_intent()   [existing, unmodified]
        -> TestPlan
        -> the existing, verified execution core

Nothing in this module imports or calls compile_intent(), RunService, or
PerformanceEngine -- that composition is the CALLER's responsibility (see
tests/test_intent_interpreter.py), which is what keeps every
IntentInterpreter implementation fully decoupled from, and unable to
influence, the deterministic compiler and everything downstream of it.

--- Interpretation states -------------------------------------------------

Deliberately a DIFFERENT enum from IntentStatus (READY /
NEEDS_CLARIFICATION / INVALID, app/schemas/enums.py) -- that enum answers
"is this structured intent ready to compile", computed by the compiler.
InterpretationStatus answers a different, upstream question: "how well did
raw language map onto the schema", answered by the interpreter. Conflating
the two would blur exactly the boundary this module exists to draw, so
this enum lives here, not in the shared schema module, and callers must
not use one in place of the other.

  COMPLETE                The interpreter produced a fully-specified
                           intent. This does NOT authorize execution --
                           `compile_intent()` still independently validates
                           it (workload limits, endpoint syntax, etc.).

  INCOMPLETE               The input was understandable but underspecified
                           (e.g. "Test my checkout API"). The interpreter
                           returns whatever it legitimately understood
                           (here: the endpoint) and leaves everything else
                           unset -- NEVER invented. The existing compiler
                           remains the sole authority on what's missing and
                           what clarification to ask for; this module does
                           not duplicate that logic (see Phase 7 of the
                           brief this was built against).

  AMBIGUOUS                Raw language cannot be SAFELY mapped to any
                           deterministic schema value (e.g. "heavy" has no
                           defined test_type/VU mapping in this product).
                           `intent` is None -- there is nothing safe to
                           hand to the compiler. Ambiguity is surfaced, not
                           guessed.

  INVALID                  The request is understood but describes
                           something unsupported, contradictory, or
                           structurally out of bounds (e.g. an adversarial
                           request). `intent` is None.

  INTERPRETATION_FAILURE   The interpreter/provider itself failed (a
                           future real implementation: timeout, exception,
                           malformed model output) -- not a classification
                           of the user's request at all. `intent` is None.
"""
from __future__ import annotations

from enum import Enum
from typing import Optional, Protocol

from pydantic import BaseModel

from app.schemas.enums import TestType
from app.schemas.intent import LoadProfile, TargetScope, UniversalPerformanceIntent


class InterpretationStatus(str, Enum):
    COMPLETE = "COMPLETE"
    INCOMPLETE = "INCOMPLETE"
    AMBIGUOUS = "AMBIGUOUS"
    INVALID = "INVALID"
    INTERPRETATION_FAILURE = "INTERPRETATION_FAILURE"


class InterpretationResult(BaseModel):
    """Kept deliberately minimal -- no confidence score (see module note
    below), no separate clarifications list (the existing
    `UniversalPerformanceIntent.clarifications_needed` is reused for that;
    inventing a second, competing clarifications concept here would
    duplicate a structure that already exists and is already handled by
    compile_intent()).

    `intent` is populated only for COMPLETE and INCOMPLETE; it is None for
    AMBIGUOUS, INVALID, and INTERPRETATION_FAILURE -- there is nothing safe
    to compile in those cases, by construction, not by caller discipline.

    No confidence field exists here on purpose: an earlier part of this
    architecture (ConfidenceInfo on UniversalPerformanceIntent itself) is
    already documented as advisory-only and never read by the compiler for
    a decision. Adding a second confidence concept at the interpretation
    layer would invite exactly the authority creep that principle exists
    to prevent.
    """

    status: InterpretationStatus
    intent: Optional[UniversalPerformanceIntent] = None
    reason: Optional[str] = None


class IntentInterpreter(Protocol):
    def interpret(self, user_input: str) -> InterpretationResult:
        ...


# --- Reference implementation ----------------------------------------------
#
# A fixed, hand-enumerated lookup table over an exact, small set of known
# inputs (after trivial whitespace/case normalization) -- NOT natural-
# language understanding, not a regex engine, not a generalizing parser.
# It exists to validate this module's architecture and tests, and to give
# tests/test_intent_interpreter.py something concrete to compose with
# compile_intent(). Any input outside its known set raises ValueError: a
# test-usage error, not a representative behavior of a real interpreter --
# a real implementation would return INTERPRETATION_FAILURE or AMBIGUOUS
# for unrecognized input instead of raising, but this fixture is not that.

_KNOWN_INTERPRETATIONS: dict[str, InterpretationResult] = {
    "run a baseline test on /products with 50 users for 30s": InterpretationResult(
        status=InterpretationStatus.COMPLETE,
        intent=UniversalPerformanceIntent(
            objective="Run a baseline test on /products with 50 users for 30s",
            test_type=TestType.baseline,
            load_profile=LoadProfile(concurrent_users=50),
            duration="30s",
            target_scope=TargetScope(endpoints=["/products"]),
        ),
    ),
    "test my checkout api": InterpretationResult(
        status=InterpretationStatus.INCOMPLETE,
        intent=UniversalPerformanceIntent(
            objective="Test my checkout API",
            target_scope=TargetScope(endpoints=["/checkout"]),
            # test_type, load_profile, duration deliberately left unset --
            # not invented. compile_intent() is authoritative on what's
            # missing and what clarification question to ask.
        ),
        reason="endpoint /checkout recognized; test_type, load, and duration were not specified",
    ),
    "run a heavy test": InterpretationResult(
        status=InterpretationStatus.AMBIGUOUS,
        intent=None,
        reason="'heavy' does not map to any deterministic test_type or load value in this product",
    ),
    "run a ddos attack on production": InterpretationResult(
        status=InterpretationStatus.INVALID,
        intent=None,
        reason="adversarial/destructive intent is not a supported performance-test request",
    ),
}


class DeterministicIntentInterpreter:
    """See module docstring above and the `_KNOWN_INTERPRETATIONS` note --
    this is a deterministic fixture proving the IntentInterpreter contract,
    not production NLP."""

    def interpret(self, user_input: str) -> InterpretationResult:
        key = user_input.strip().lower()
        try:
            canned = _KNOWN_INTERPRETATIONS[key]
        except KeyError:
            raise ValueError(
                f"DeterministicIntentInterpreter has no fixture for input {user_input!r} -- "
                "this is a fixed, hand-enumerated lookup table over a small known set, "
                "not a general-purpose interpreter."
            ) from None
        # Deep-copy so callers can never mutate the shared table entry out
        # from under later calls -- keeps interpret() pure per call.
        return canned.model_copy(deep=True)
