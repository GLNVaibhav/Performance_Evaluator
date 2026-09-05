from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class TestPlanRecord(Base):
    __tablename__ = "test_plans"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    objective_type: Mapped[str] = mapped_column(String, nullable=False)
    test_type: Mapped[str] = mapped_column(String, nullable=False)
    # Full validated TestPlan, serialized. Source of truth for what was run.
    plan_json: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class TestRunRecord(Base):
    __tablename__ = "test_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("test_plans.id"), nullable=False)
    target_base_url: Mapped[str] = mapped_column(String, nullable=False)
    state: Mapped[str] = mapped_column(String, nullable=False)
    artifact_dir: Mapped[str] = mapped_column(String, nullable=False)
    error_message: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class TestResultRecord(Base):
    __tablename__ = "test_results"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("test_runs.id"), nullable=False, unique=True)
    p50_ms: Mapped[float] = mapped_column(Float, nullable=False)
    p95_ms: Mapped[float] = mapped_column(Float, nullable=False)
    p99_ms: Mapped[float] = mapped_column(Float, nullable=False)
    average_ms: Mapped[float] = mapped_column(Float, nullable=False)
    max_ms: Mapped[float] = mapped_column(Float, nullable=False)
    rps: Mapped[float] = mapped_column(Float, nullable=False)
    total_requests: Mapped[int] = mapped_column(Integer, nullable=False)
    failed_requests: Mapped[int] = mapped_column(Integer, nullable=False)
    error_rate: Mapped[float] = mapped_column(Float, nullable=False)
    duration_s: Mapped[float] = mapped_column(Float, nullable=False)
    threshold_status: Mapped[str] = mapped_column(String, nullable=False)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    # Additive (endpoint mix + per-endpoint evidence amendment): JSON-serialized
    # list of EndpointMetrics dicts, same pattern as TestPlanRecord.plan_json.
    # Nullable so it never breaks reading a row written before this column
    # existed on a persisted (non-fresh) database.
    per_endpoint_json: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Additive, same pattern/rationale as per_endpoint_json above.
    threshold_violations_json: Mapped[Optional[str]] = mapped_column(String, nullable=True)
