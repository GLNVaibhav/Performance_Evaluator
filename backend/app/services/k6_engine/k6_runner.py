"""Real k6 subprocess execution. shell=False, argv arrays only (section 13).

Canonical MVP artifact contract (frozen, performance_engine_interface.md):
  k6 run --summary-trend-stats="min,med,avg,max,p(50),p(75),p(90),p(95),p(99)"
         --summary-export=<artifact_directory>/results.json
         <artifact_directory>/script.js

NDJSON (`--out json=`) is explicitly NOT part of the MVP contract -- not
requested here, per section 4.

`p(75)`/`p(90)` added Session 5 -- purely additive to an already-computed
k6 trend metric (k6 does not compute a *new* statistic; it just also
prints two more percentiles of data it already has), verified empirically
against the pinned k6 v2.2.0 binary to appear correctly in
`--summary-export` output alongside the pre-existing percentiles. Never
invented/estimated in Python -- if a `results.json` predates this change
(no `p(75)`/`p(90)` key), `metrics_parser.py` leaves those fields absent
rather than backfilling a guess.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional

_SUMMARY_TREND_STATS = "min,med,avg,max,p(50),p(75),p(90),p(95),p(99)"


@dataclass
class K6RunOutcome:
    exit_code: int
    results_path: Path
    results_exists: bool
    stdout_path: Path
    stderr_path: Path
    started_at: datetime
    finished_at: datetime
    error_message: str | None  # set only on a genuine execution failure


def run_k6(
    script_path: Path,
    artifact_directory: Path,
    k6_binary: str,
    timeout_s: float,
    env: Optional[Dict[str, str]] = None,
) -> K6RunOutcome:
    """`env`, if given, is merged ON TOP OF the current process environment
    for the k6 subprocess only (never written to disk, never part of
    `cmd`/argv, so it never appears in `script.js`, `results.json`, or
    either log file). Used by app/services/k6_engine/engine.py to pass
    app/services/auth_headers.py::build_auth_env()'s (name, value) pair --
    the k6 script (script_renderer.py) reads it back via k6's own __ENV
    global at runtime. Omitting `env` (the default) reproduces the exact
    prior behavior: the subprocess inherits the parent process's
    environment unchanged, same as passing `env=None` to `subprocess.run`
    always has."""
    results_path = artifact_directory / "results.json"
    stdout_path = artifact_directory / "stdout.log"
    stderr_path = artifact_directory / "stderr.log"

    cmd = [
        k6_binary,
        "run",
        "--summary-trend-stats",
        _SUMMARY_TREND_STATS,
        "--summary-export",
        str(results_path),
        str(script_path),
    ]

    subprocess_env = {**os.environ, **env} if env else None

    started_at = datetime.now(timezone.utc)
    error_message: str | None = None
    stdout, stderr = "", ""
    exit_code = -1

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(artifact_directory),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            shell=False,
            env=subprocess_env,
        )
        exit_code = proc.returncode
        stdout, stderr = proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = (exc.stderr or "") + f"\n[k6 execution timed out after {timeout_s}s]"
        error_message = f"k6 execution timed out after {timeout_s}s"
    except FileNotFoundError as exc:
        error_message = f"k6 binary not found ('{k6_binary}'): {exc}"
    except OSError as exc:
        error_message = f"failed to start k6 subprocess: {exc}"

    finished_at = datetime.now(timezone.utc)

    artifact_directory.mkdir(parents=True, exist_ok=True)
    stdout_path.write_text(stdout)
    stderr_path.write_text(stderr)

    results_exists = results_path.exists()

    # IMPORTANT: error_message is preserved regardless of results_exists.
    # A non-zero exit code is an execution failure EVEN IF k6 still wrote
    # a results.json (e.g. a script/runtime error partway through, or the
    # process being killed after partially flushing output) -- the caller
    # (engine.py) must never treat a present results.json as license to
    # ignore a failed process. Previously this field was unconditionally
    # cleared to None whenever results_exists was True, which silently
    # discarded the non-zero-exit signal. See BLOCKER 2 fix.
    if error_message is None and exit_code != 0:
        error_message = f"k6 exited with non-zero status {exit_code}"
    elif error_message is None and not results_exists:
        error_message = f"k6 exited {exit_code} with no results.json artifact"

    return K6RunOutcome(
        exit_code=exit_code,
        results_path=results_path,
        results_exists=results_exists,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        started_at=started_at,
        finished_at=finished_at,
        error_message=error_message,
    )
