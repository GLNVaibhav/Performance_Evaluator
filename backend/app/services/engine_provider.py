"""Single wiring point for which PerformanceEngine implementation the API
uses. Swap this when Developer 2's real engine is ready -- nothing else in
app/api or app/services/run_service.py needs to change.
"""

from app.services.performance_engine import PerformanceEngine
from app.services.reference_k6_engine import ReferenceK6Engine

_engine: PerformanceEngine = ReferenceK6Engine()


def get_performance_engine() -> PerformanceEngine:
    return _engine
