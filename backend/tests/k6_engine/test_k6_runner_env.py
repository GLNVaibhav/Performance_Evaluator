"""Session 2.5: k6_runner.run_k6()'s new `env` parameter -- unit-level,
mocked subprocess (mirrors the existing style of
test_engine_exit_semantics.py's mocked-outcome tests; the REAL end-to-end
proof that env vars actually reach k6 and become HTTP headers lives in
test_auth_propagation_execution.py).
"""
import os
from pathlib import Path
from unittest.mock import patch

from app.services.k6_engine.k6_runner import run_k6


def _fake_completed_process(returncode=0):
    class _Proc:
        pass

    p = _Proc()
    p.returncode = returncode
    p.stdout = ""
    p.stderr = ""
    return p


def test_no_env_argument_passes_env_none_to_subprocess_backward_compat(tmp_path):
    """The default (no `env` kwarg) must reproduce the exact prior call --
    `subprocess.run(..., env=None)` -- so the subprocess inherits the
    current process's environment unchanged, same as every existing
    caller of run_k6() before this parameter existed."""
    script_path = tmp_path / "script.js"
    script_path.write_text("export default function () {}")

    with patch("subprocess.run", return_value=_fake_completed_process()) as mock_run:
        run_k6(script_path=script_path, artifact_directory=tmp_path, k6_binary="k6", timeout_s=5)

    _, kwargs = mock_run.call_args
    assert kwargs["env"] is None


def test_env_argument_is_merged_on_top_of_current_process_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("PE_TEST_PREEXISTING_VAR", "should-survive")
    script_path = tmp_path / "script.js"
    script_path.write_text("export default function () {}")

    with patch("subprocess.run", return_value=_fake_completed_process()) as mock_run:
        run_k6(
            script_path=script_path,
            artifact_directory=tmp_path,
            k6_binary="k6",
            timeout_s=5,
            env={"PERF_EVAL_AUTH_HEADER_NAME": "Authorization", "PERF_EVAL_AUTH_HEADER_VALUE": "Bearer secret"},
        )

    _, kwargs = mock_run.call_args
    passed_env = kwargs["env"]
    assert passed_env is not None
    assert passed_env["PERF_EVAL_AUTH_HEADER_NAME"] == "Authorization"
    assert passed_env["PERF_EVAL_AUTH_HEADER_VALUE"] == "Bearer secret"
    # The rest of the current process's environment is preserved, not replaced.
    assert passed_env["PE_TEST_PREEXISTING_VAR"] == "should-survive"


def test_empty_env_dict_is_treated_the_same_as_no_env(tmp_path):
    script_path = tmp_path / "script.js"
    script_path.write_text("export default function () {}")

    with patch("subprocess.run", return_value=_fake_completed_process()) as mock_run:
        run_k6(script_path=script_path, artifact_directory=tmp_path, k6_binary="k6", timeout_s=5, env={})

    _, kwargs = mock_run.call_args
    assert kwargs["env"] is None
