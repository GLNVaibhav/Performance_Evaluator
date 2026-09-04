"""Single wiring point for which PerformanceEngine implementation the API
uses. Nothing else in app/api or app/services/run_service.py needs to
change when the implementation here changes.
"""

from app.services.k6_engine.engine import RealK6PerformanceEngine
from app.services.performance_engine import PerformanceEngine

_engine: PerformanceEngine = RealK6PerformanceEngine()


def get_performance_engine() -> PerformanceEngine:
    return _engine
