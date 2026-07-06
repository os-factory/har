#!/usr/bin/env python3
"""Orchestrate paired raw vs HAR benchmark runs."""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT, benchmark_config, benchmark_issues, benchmark_repos, write_json  # noqa: E402


def run_script(script: str, args: list[str]) -> tuple[int, str]:
    cmd = [sys.executable, str(SCRIPT_DIR / script), *args]
    result = subprocess.run(cmd, check=False, capture_output=True, text=True)
    output = (result.stdout or "") + (result.stderr or "")
    return result.returncode, output.strip()


def filter_issues(issues: list[dict], repo: str | None, limit: int | None) -> list[dict]:
    filtered = issues
    if repo:
        filtered = [issue for issue in filtered if issue["repo"] == repo or issue["repo"].endswith(f"/{repo}") or issue.get("id", "").startswith(repo)]
    if limit is not None:
        filtered = filtered[:limit]
    return filtered


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["pilot", "full"], default="pilot")
    parser.add_argument("--repo")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-evaluate", action="store_true")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    config = benchmark_config()
    issues = benchmark_issues()
    if not issues:
        raise SystemExit("issues.yaml is empty. Run scripts/select_issues.py first.")

    if args.mode == "pilot":
        pilot_repo = args.repo or config["pilot"]["repo"]
        limit = config["pilot"]["issue_count"]
        issues = filter_issues(issues, pilot_repo, limit)
    else:
        issues = filter_issues(issues, args.repo, None)

    random.seed(args.seed)
    manifest = {"mode": args.mode, "seed": args.seed, "pairs": []}
    for issue in issues:
        arms = ["raw", "har"]
        random.shuffle(arms)
        pair = {"issue": issue["issue_url"], "order": arms, "runs": []}
        for arm in arms:
            cmd = [
                "--arm",
                arm,
                "--repo",
                issue["repo"],
                "--issue-number",
                str(issue["issue_number"]),
            ]
            if args.dry_run:
                cmd.append("--dry-run")
            code, output = run_script("run_task.py", cmd)
            run_json = None
            try:
                payload = json.loads(output.splitlines()[-1])
                run_json = Path(payload["run_dir"]) / "run.json"
            except (json.JSONDecodeError, KeyError, IndexError):
                run_json = None
            pair["runs"].append({"arm": arm, "exit_code": code, "output": output[-500:]})
            if not args.skip_evaluate and run_json and run_json.exists():
                run_script("evaluate_run.py", ["--run-json", str(run_json), "--dry-run"])
        manifest["pairs"].append(pair)

    write_json(BENCHMARK_ROOT / "results" / f"benchmark-{args.mode}-manifest.json", manifest)
    run_script("report.py", [])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
