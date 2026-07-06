#!/usr/bin/env python3
"""Smoke tests for benchmark scripts (no Claude Code or Langfuse required)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)


def test_issues_file_has_fifty_items() -> None:
    issues = json.loads((ROOT / "issues.json").read_text(encoding="utf-8"))["issues"]
    assert len(issues) == 50, f"expected 50 issues, got {len(issues)}"


def test_dry_run_pilot() -> None:
    result = run([sys.executable, str(SCRIPTS / "run_benchmark.py"), "--mode", "pilot", "--dry-run"])
    assert result.returncode == 0, result.stderr


def test_dry_run_full() -> None:
    result = run([sys.executable, str(SCRIPTS / "run_benchmark.py"), "--mode", "full", "--dry-run"])
    assert result.returncode == 0, result.stderr


def test_report_generation() -> None:
    result = run([sys.executable, str(SCRIPTS / "report.py")])
    assert result.returncode == 0, result.stderr
    assert (ROOT / "results" / "report.md").exists()


def main() -> int:
    tests = [
        test_issues_file_has_fifty_items,
        test_dry_run_pilot,
        test_dry_run_full,
        test_report_generation,
    ]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    print(f"All {len(tests)} smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
