#!/usr/bin/env python3
"""Smoke tests for benchmark scripts (no Claude Code or Langfuse required)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from lib.common import (  # noqa: E402
    build_verification_block,
    infer_oracle_command,
    is_test_file,
    patch_overlap,
    pr_within_scope,
)


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)


def test_issues_schema_v2() -> None:
    issues = json.loads((ROOT / "issues.json").read_text(encoding="utf-8"))["issues"]
    assert issues, "issues.json must not be empty"
    for issue in issues:
        assert issue.get("verification", {}).get("primary", {}).get("command"), f"missing oracle: {issue.get('id')}"


def test_oracle_helpers() -> None:
    assert is_test_file("packages/frontend/src/Routes.test.tsx")
    assert not is_test_file("packages/frontend/src/Routes.tsx")
    repo = {"package_manager": "pnpm"}
    cmd = infer_oracle_command(repo, ["packages/frontend/src/Routes.test.tsx"])
    assert cmd and cmd[0] == "pnpm"
    block = build_verification_block(repo, ["packages/frontend/src/foo.test.ts"])
    assert block["primary"]["command"]
    assert patch_overlap(["a.ts", "b.ts"], ["b.ts", "c.ts"]) == 0.5
    assert pr_within_scope([{"changes": 100}, {"changes": 50}], max_files=5, max_lines=400)


def test_dry_run_pilot() -> None:
    result = run([sys.executable, str(SCRIPTS / "run_benchmark.py"), "--mode", "pilot", "--dry-run"])
    assert result.returncode == 0, result.stderr


def test_dry_run_pilot_v2() -> None:
    result = run([sys.executable, str(SCRIPTS / "run_benchmark.py"), "--mode", "pilot-v2", "--dry-run", "--skip-gate"])
    assert result.returncode == 0, result.stderr


def test_report_generation() -> None:
    result = run([sys.executable, str(SCRIPTS / "report.py")])
    assert result.returncode == 0, result.stderr
    assert (ROOT / "results" / "report.md").exists()


def main() -> int:
    tests = [
        test_oracle_helpers,
        test_issues_schema_v2,
        test_dry_run_pilot,
        test_dry_run_pilot_v2,
        test_report_generation,
    ]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    print(f"All {len(tests)} smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
