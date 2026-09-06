"""Single wiring point for which AIAnalyzer implementation the API uses --
mirrors app/services/interpreter_provider.py's and
app/services/engine_provider.py's exact convention. Nothing else in
app/api needs to change if the implementation here changes.
"""

from app.services.ai_analyzer import AIAnalyzer, AIResultAnalyzer

_analyzer: AIAnalyzer = AIResultAnalyzer()


def get_ai_analyzer() -> AIAnalyzer:
    return _analyzer
