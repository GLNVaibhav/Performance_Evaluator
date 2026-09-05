"""Single wiring point for which IntentInterpreter implementation the API
uses -- mirrors app/services/engine_provider.py's exact convention. Nothing
else in app/api needs to change if the implementation here changes.
"""

from app.services.intent_interpreter import IntentInterpreter
from app.services.llm_intent_interpreter import LLMIntentInterpreter

_interpreter: IntentInterpreter = LLMIntentInterpreter()


def get_intent_interpreter() -> IntentInterpreter:
    return _interpreter
