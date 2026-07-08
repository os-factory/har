#!/usr/bin/env python3
"""Smoke tests for the SWE-bench HAR benchmark (no Codex / Docker required)."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from lib.common import benchmark_config, render_template, sanitize_instance_row  # noqa: E402
from lib.patch import extract_model_patch, filter_changed_files  # noqa: E402
from lib.profile import infer_har_profile  # noqa: E402


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)


def test_config_loads() -> None:
    cfg = benchmark_config()
    assert cfg["dataset_name"] == "SWE-bench/SWE-bench_Lite"
    assert cfg["model"] == "gpt-5-mini"


def test_sanitize_instance() -> None:
    row = {
        "instance_id": "foo__bar-1",
        "repo": "foo/bar",
        "base_commit": "abc",
        "problem_statement": "fix it",
        "patch": "secret",
        "test_patch": "secret",
        "FAIL_TO_PASS": "[]",
    }
    safe = sanitize_instance_row(row)
    assert "patch" not in safe
    assert "test_patch" not in safe
    assert safe["problem_statement"] == "fix it"


def test_profile_inference() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        (repo / "pyproject.toml").write_text("[project]\nname='x'\n", encoding="utf-8")
        assert infer_har_profile(repo) == "cli"
        (repo / "next.config.js").write_text("module.exports = {}", encoding="utf-8")
        assert infer_har_profile(repo) == "default"


def test_patch_filtering() -> None:
    files = [".har/verify.sh", "src/fix.py", "AGENT.md", "lib/a.py"]
    kept = filter_changed_files(files)
    assert set(kept) == {"src/fix.py", "lib/a.py"}


def test_patch_extraction_excludes_har() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "a@b.c"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "bench"], cwd=repo, check=True)
        (repo / "README.md").write_text("base\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True)
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
        ).stdout.strip()
        (repo / "src.py").write_text("print(1)\n", encoding="utf-8")
        (repo / ".har").mkdir()
        (repo / ".har" / "verify.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-m", "changes"], cwd=repo, check=True)
        patch = extract_model_patch(repo, base)
        assert "src.py" in patch
        assert ".har/verify.sh" not in patch
        assert "har/verify.sh" not in patch


def test_prompt_render() -> None:
    text = render_template(
        ROOT / "prompts" / "raw-fix.md",
        {
            "repo": "foo/bar",
            "instance_id": "foo__bar-1",
            "base_commit": "abc",
            "problem_statement": "broken",
        },
    )
    assert "foo/bar" in text
    assert "broken" in text
    assert "{{" not in text


def test_dry_run_orchestration() -> None:
    result = run([sys.executable, str(SCRIPTS / "run_one.py"), "--seed", "7", "--dry-run"])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout.strip())
    run_dir = Path(payload["run_dir"])
    assert (run_dir / "instance.json").exists()
    assert (run_dir / "run.json").exists()


def test_evaluate_dry_run() -> None:
    run([sys.executable, str(SCRIPTS / "run_one.py"), "--seed", "8", "--dry-run"])
    result = run([sys.executable, str(SCRIPTS / "evaluate_predictions.py"), "--latest", "--dry-run"])
    assert result.returncode == 0, result.stderr


def main() -> int:
    tests = [
        test_config_loads,
        test_sanitize_instance,
        test_profile_inference,
        test_patch_filtering,
        test_patch_extraction_excludes_har,
        test_prompt_render,
        test_dry_run_orchestration,
        test_evaluate_dry_run,
    ]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    print(f"All {len(tests)} smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
