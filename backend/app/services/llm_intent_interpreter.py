"""LLMIntentInterpreter: a real, provider-backed IntentInterpreter
(app/services/intent_interpreter.py) implementation. Second, alongside
the existing DeterministicIntentInterpreter, of that same Protocol -- not
a replacement, and not a modification of the Protocol itself.

ARCHITECTURAL BOUNDARY (see intent_interpreter.py's module docstring,
unchanged): this class produces ONLY an InterpretationResult. It never
imports compile_intent, RunService, PerformanceEngine, or the k6 engine --
confirmed by this file's own import list. Composition with the
deterministic compiler is entirely the CALLER's responsibility (the new
POST /api/v1/intents/interpret route, and separately POST
/api/v1/intents/compile), exactly like the deterministic interpreter.

OpenAI-compatible chat-completions API over plain httpx (already a
dependency) -- no new SDK, no LangChain, no agent framework. Works
unmodified against OpenAI itself or any compatible provider by pointing
LLM_BASE_URL at it (see app/core/config.py).

Required pipeline (never trust the raw provider response):

    LLM HTTP response
        -> JSON extraction (strip an optional markdown code fence)
        -> json.loads                      -> malformed JSON -> INTERPRETATION_FAILURE
        -> status/enum validation          -> unrecognized status -> INTERPRETATION_FAILURE
        -> UniversalPerformanceIntent.model_validate(intent)  -- the EXISTING
           schema, not a duplicate one -- invalid field/type/value -> INTERPRETATION_FAILURE
        -> endpoint-containment check (if available_endpoints configured) --
           any endpoint outside that closed set -> INTERPRETATION_FAILURE
           (hallucination is a model-reliability failure, not a user-intent
           classification -- see module docstring in intent_interpreter.py
           for why INTERPRETATION_FAILURE is reserved for exactly this kind
           of "the interpreter itself didn't behave", as opposed to
           AMBIGUOUS/INVALID which classify the user's actual request)
        -> InterpretationResult

No value is ever invented or silently repaired at any stage -- a failure
at any step maps to INTERPRETATION_FAILURE with a reason describing what
went wrong, never a best-effort guess.
"""
from __future__ import annotations

import json
from typing import List, Optional

import httpx
from pydantic import ValidationError

from app.core.config import LLM_API_KEY, LLM_BASE_URL, LLM_KNOWN_ENDPOINTS, LLM_MODEL, LLM_TIMEOUT_S
from app.schemas.enums import TestType
from app.schemas.intent import UniversalPerformanceIntent
from app.services.intent_interpreter import InterpretationResult, InterpretationStatus

_RESPONSE_JSON_SHAPE = """\
Respond with ONLY a single JSON object, no prose, no markdown code fence, matching exactly:

{
  "status": "COMPLETE" | "INCOMPLETE" | "AMBIGUOUS" | "INVALID",
  "intent": {
    "objective": string or null,
    "test_type": one of %(test_types)s, or null,
    "load_profile": {
      "concurrent_users": positive integer or null,
      "peak_users": positive integer or null
    },
    "duration": string matching "^\\d+(ms|s|m|h)$" (e.g. "30s", "5m"), or null,
    "target_scope": {
      "endpoints": array of strings from the known-endpoints list below, or null,
      "endpoint_weights": object mapping each selected endpoint to a positive number, or null
    },
    "success_criteria": {
      "p95_latency_ms": positive integer or null,
      "error_rate": number between 0 and 1 or null
    }
  } or null,
  "reason": string or null
}
"""


def _build_system_prompt(available_endpoints: Optional[List[str]]) -> str:
    test_types = ", ".join(f'"{t.value}"' for t in TestType)
    shape = _RESPONSE_JSON_SHAPE % {"test_types": f"[{test_types}]"}

    endpoint_rules = (
        (
            "Known endpoints for this target (this is the COMPLETE list -- you "
            "may only select target_scope.endpoints values from it, exactly as "
            "written; never invent, modify, or guess a path not in this list):\n"
            + "\n".join(f"  - {e}" for e in available_endpoints)
        )
        if available_endpoints
        else "No known-endpoint list was supplied. Leave target_scope.endpoints null "
        "unless the user's text unambiguously names a literal path."
    )

    return f"""\
You convert a natural-language API performance-testing request into a
structured UniversalPerformanceIntent-compatible JSON object. You do not
run tests, generate scripts, generate code, or recommend/trigger
execution -- you only interpret the request into structured data.

RULES (follow every one exactly):

1. Never invent a value. If the user did not specify concurrency,
   duration, thresholds, or an endpoint mix, leave that field null. A
   null field is always correct when the information genuinely was not
   given; a guessed value is always wrong.
2. The only supported test_type values are: {test_types}. Do not use any
   other value, even if the user's wording suggests something else.
3. Only produce the fields shown in the JSON shape below. Do not add
   fields that are not part of it.
4. Never produce a TestPlan, k6 script, or any executable code.
5. Never recommend or claim to trigger execution.
6. status classification:
   - COMPLETE: you were able to fill in every field the request needed
     for its stated goal (it's fine for genuinely optional fields like
     success_criteria to stay null if unmentioned).
   - INCOMPLETE: the request is understandable but missing information
     needed to run it (e.g. no user count, no duration). Fill in
     whatever you legitimately understood and leave the rest null --
     do not upgrade this to COMPLETE by guessing the missing piece.
   - AMBIGUOUS: the wording cannot be SAFELY mapped to any specific
     value (e.g. "heavy", "a lot", "extreme" have no defined mapping to
     a number or test_type in this system). Set intent to null and
     explain why in reason. Never pick an arbitrary number "as a
     reasonable guess."
   - INVALID: the request is understood but describes something
     unsupported, contradictory, or out of bounds for a performance
     test (e.g. asking to attack/damage a system, or a test type this
     system doesn't support). Set intent to null and explain why in
     reason.
7. {endpoint_rules}

{shape}
"""


class LLMIntentInterpreter:
    """Real IntentInterpreter implementation backed by an OpenAI-compatible
    chat-completions API. See module docstring for the full pipeline and
    the architectural boundary this respects."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout_s: Optional[float] = None,
        available_endpoints: Optional[List[str]] = None,
        http_client: Optional[httpx.Client] = None,
    ):
        self._api_key = LLM_API_KEY if api_key is None else api_key
        self._model = LLM_MODEL if model is None else model
        self._base_url = (LLM_BASE_URL if base_url is None else base_url).rstrip("/")
        self._timeout_s = LLM_TIMEOUT_S if timeout_s is None else timeout_s
        self._available_endpoints = (
            list(LLM_KNOWN_ENDPOINTS) if available_endpoints is None else list(available_endpoints)
        )
        # Injected in tests via httpx.Client(transport=httpx.MockTransport(...))
        # for fully offline, deterministic testing of the REAL parsing/
        # validation code path -- not a custom test-only abstraction.
        self._http_client = http_client

    def interpret(self, user_input: str) -> InterpretationResult:
        try:
            raw_content = self._call_provider(user_input)
        except Exception as exc:  # provider/network/auth/timeout failure -- never a user-intent classification
            return InterpretationResult(
                status=InterpretationStatus.INTERPRETATION_FAILURE,
                reason=f"LLM provider call failed: {exc}",
            )

        try:
            parsed = json.loads(_strip_code_fence(raw_content))
        except json.JSONDecodeError as exc:
            return InterpretationResult(
                status=InterpretationStatus.INTERPRETATION_FAILURE,
                reason=f"LLM did not return valid JSON: {exc}",
            )

        return self._to_interpretation_result(parsed)

    def _call_provider(self, user_input: str) -> str:
        client = self._http_client or httpx.Client(timeout=self._timeout_s)
        owns_client = self._http_client is None
        try:
            response = client.post(
                f"{self._base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
                json={
                    "model": self._model,
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": _build_system_prompt(self._available_endpoints)},
                        {"role": "user", "content": user_input},
                    ],
                },
                timeout=self._timeout_s,
            )
            response.raise_for_status()
            body = response.json()
            return body["choices"][0]["message"]["content"]
        finally:
            if owns_client:
                client.close()

    def _to_interpretation_result(self, parsed: dict) -> InterpretationResult:
        try:
            status = InterpretationStatus(parsed["status"])
        except (KeyError, ValueError) as exc:
            return InterpretationResult(
                status=InterpretationStatus.INTERPRETATION_FAILURE,
                reason=f"LLM output had an unrecognized or missing status: {exc}",
            )

        # The model must never itself claim provider failure -- that status
        # is reserved for THIS layer, not something trusted from the model.
        if status == InterpretationStatus.INTERPRETATION_FAILURE:
            return InterpretationResult(
                status=InterpretationStatus.INTERPRETATION_FAILURE,
                reason="LLM output illegally claimed INTERPRETATION_FAILURE itself",
            )

        reason = parsed.get("reason")
        reason = reason if isinstance(reason, str) else None

        if status in (InterpretationStatus.AMBIGUOUS, InterpretationStatus.INVALID):
            return InterpretationResult(status=status, intent=None, reason=reason)

        raw_intent = parsed.get("intent")
        if not isinstance(raw_intent, dict):
            return InterpretationResult(
                status=InterpretationStatus.INTERPRETATION_FAILURE,
                reason=f"LLM status was {status.value} but 'intent' was not an object",
            )

        try:
            intent = UniversalPerformanceIntent.model_validate(raw_intent)
        except ValidationError as exc:
            return InterpretationResult(
                status=InterpretationStatus.INTERPRETATION_FAILURE,
                reason=f"LLM output failed UniversalPerformanceIntent validation: {exc}",
            )

        containment_error = self._check_endpoint_containment(intent)
        if containment_error is not None:
            return InterpretationResult(status=InterpretationStatus.INTERPRETATION_FAILURE, reason=containment_error)

        return InterpretationResult(status=status, intent=intent, reason=reason)

    def _check_endpoint_containment(self, intent: UniversalPerformanceIntent) -> Optional[str]:
        if not self._available_endpoints:
            return None
        selected = intent.target_scope.endpoints or []
        unknown = [e for e in selected if e not in self._available_endpoints]
        if unknown:
            return (
                f"LLM selected endpoint(s) outside the known set for this target: {unknown} "
                f"(known: {self._available_endpoints})"
            )
        return None


def _strip_code_fence(text: str) -> str:
    """Defensive only -- response_format=json_object should already prevent
    this, but not every OpenAI-compatible provider honors that field, and
    the raw response must never be trusted as-is."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        if stripped.startswith("json"):
            stripped = stripped[4:]
        stripped = stripped.strip()
    return stripped
