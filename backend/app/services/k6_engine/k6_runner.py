"""Real k6 subprocess execution. shell=False, argv arrays only (section 13).

Canonical MVP artifact contract (frozen, performance_engine_interface.md):
  k6 run --summary-trend-stats="min,med,avg,max,p(50),p(95),p(99)"
         --summary-export=<artifact_directory>/results.json
         <artifact_directory>/script.js

NDJSON (`--out json=`) is explicitly NOT part of the MVP contract -- not
requested here, per section 4.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

_SUMMARY_TREND_STATS = "min,med,avg,max,p(50),p(95),p(99)"


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
) -> K6RunOutcome:
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
