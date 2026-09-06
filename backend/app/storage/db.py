from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from app.core.config import DATABASE_URL

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def _add_missing_columns() -> None:
    """`Base.metadata.create_all()` only creates tables that don't exist yet
    -- it never ALTERs an existing table to add a column a model gained
    later (confirmed root cause of a real bug: `test_results` gained
    `p75_ms`/`p90_ms`/`status_codes_json` in Session 5, but a database file
    created before that kept its old physical schema forever; every
    subsequent INSERT raised `sqlite3.OperationalError: table test_results
    has no column named p75_ms`, uncaught, silently stranding every run at
    RUNNING). Every column added to a model since launch has been nullable
    for exactly this reason (see per_endpoint_json/threshold_violations_json/
    status_codes_json's own docstrings) -- so adding it with no default is
    always valid for pre-existing rows. SQLite only supports adding one
    column per ALTER TABLE statement, nothing else (no rename/drop/type
    change) -- sufficient for this, not a general migration tool."""
    from app.storage import models

    inspector = inspect(engine)
    with engine.begin() as conn:
        for table in models.Base.metadata.sorted_tables:
            if not inspector.has_table(table.name):
                continue  # brand-new table -- create_all() already handles it
            existing_columns = {col["name"] for col in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing_columns:
                    continue
                ddl_type = column.type.compile(dialect=engine.dialect)
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {ddl_type}'))


def init_db() -> None:
    from app.storage import models  # noqa: F401  (register models on Base)

    models.Base.metadata.create_all(bind=engine)
    _add_missing_columns()
