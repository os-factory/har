#!/usr/bin/env python3
"""Preflight check that pilot repo HAR harnesses pass full verify."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    campaign_config,
    campaign_repos,
    har_teardown_slot,
    har_verify_full,
    now_iso,
    read_json,
    run_command,
    write_json,
)


def check_repo(repo: dict, workspaces_dir: Path, launch_timeout_seconds: int = 7200) -> dict:
    from lib.common import har_launch_slot

    repo_path = workspaces_dir / repo["id"]
    started = time.time()
    record = {
        "repo": f"{repo['owner']}/{repo['name']}",
        "repo_id": repo["id"],
        "repo_path": str(repo_path),
        "passed": False,
    }
    if not repo_path.exists() or not (repo_path / ".har").exists():
        record["error"] = "missing repo workspace or .har overlay"
        return record
    ok, workdir, launch_log = har_launch_slot(repo_path, 1, timeout_seconds=launch_timeout_seconds)
    record["launch_ok"] = ok
    record["launch_log"] = launch_log[-2000:]
    if not ok:
        record["error"] = "launch failed"
        return record
    verify_full = har_verify_full(repo_path, 1)
    record["verify_full"] = verify_full
    record["passed"] = verify_full["verified"]
    setup_path = BENCHMARK_ROOT / "results" / "harness-setup" / f"{repo['id']}.json"
    if setup_path.exists():
        record["harness_setup_seconds"] = read_json(setup_path).get("harness_setup_seconds", 0)
    har_teardown_slot(repo_path, 1)
    record["check_seconds"] = round(time.time() - started, 2)
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="Check one repo")
    parser.add_argument("--campaign", choices=["default", "v3"], default="default")
    parser.add_argument("--pilot-only", action="store_true")
    parser.add_argument("--launch-timeout-seconds", type=int, default=7200)
    args = parser.parse_args()

    config = campaign_config(args.campaign)
    repos = campaign_repos(args.campaign)
    if args.pilot_only:
        pilot_repos = config.get("pilot_repos") or [config.get("pilot", {}).get("repo")]
        repos = [r for r in repos if f"{r['owner']}/{r['name']}" in pilot_repos or r["id"] in pilot_repos]
    if args.repo:
        repos = [r for r in repos if r["id"] == args.repo or f"{r['owner']}/{r['name']}" == args.repo]

    workspaces_dir = BENCHMARK_ROOT / config.get("workspaces_dir", "repos")
    results = {repo["id"]: check_repo(repo, workspaces_dir, args.launch_timeout_seconds) for repo in repos}
    payload = {"generated_at": now_iso(), "repos": results}
    results_dir = BENCHMARK_ROOT / (config.get("results_dir", "results") if args.campaign == "v3" else "results")
    write_json(results_dir / "harness-gate.json", payload)
    passed = sum(1 for item in results.values() if item.get("passed"))
    print(f"Harness gate: {passed}/{len(results)} repos passed full verify")
    for repo_id, item in results.items():
        status = "PASS" if item.get("passed") else "FAIL"
        print(f"  [{status}] {repo_id}: {item.get('error') or item.get('verify_full', {}).get('details', '')}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
