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

from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    benchmark_config,
    benchmark_issues,
    benchmark_repos,
    campaign_config,
    campaign_issues,
    campaign_repos,
    repo_id_for_slug,
    repo_passes_harness_gate,
    write_json,
)


def run_script(script: str, args: list[str]) -> tuple[int, str]:
    cmd = [sys.executable, str(SCRIPT_DIR / script), *args]
    result = subprocess.run(cmd, check=False, capture_output=True, text=True)
    output = (result.stdout or "") + (result.stderr or "")
    return result.returncode, output.strip()


def filter_issues(issues: list[dict], repo: str | None, limit: int | None, pilot_repos: list[str] | None = None) -> list[dict]:
    filtered = issues
    if pilot_repos:
        filtered = [issue for issue in filtered if issue["repo"] in pilot_repos]
    if repo:
        filtered = [
            issue
            for issue in filtered
            if issue["repo"] == repo or issue["repo"].endswith(f"/{repo}") or issue.get("id", "").startswith(repo)
        ]
    if limit is not None:
        filtered = filtered[:limit]
    return filtered


def log(msg: str) -> None:
    print(msg, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["pilot", "full", "pilot-v2", "v3"], default="pilot")
    parser.add_argument("--campaign", choices=["default", "v3"], default="default")
    parser.add_argument("--repo")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-evaluate", action="store_true")
    parser.add_argument("--skip-gate", action="store_true", help="Skip harness gate check for HAR runs")
    parser.add_argument("--har-only", action="store_true", help="Run HAR arm only (skip raw; keeps completed raw runs)")
    parser.add_argument("--raw-only", action="store_true", help="Run raw arm only")
    parser.add_argument("--redo-har", action="store_true", help="Re-run HAR even when a prior completed run.json exists")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    campaign = "v3" if args.mode == "v3" or args.campaign == "v3" else "default"
    config = campaign_config(campaign)
    issues = campaign_issues(campaign) if campaign == "v3" else benchmark_issues()
    if not issues:
        raise SystemExit("issues file is empty. Run scripts/select_issues.py first.")

    pilot_repos = None
    if args.mode in {"pilot", "pilot-v2", "v3"}:
        pilot_repos = config.get("pilot_repos") or [config.get("pilot", {}).get("repo")]
        pilot_repo = args.repo or (config.get("pilot", {}) or {}).get("repo")
        limit = None if args.mode in {"pilot-v2", "v3"} else config.get("pilot", {}).get("issue_count")
        issues = filter_issues(
            issues,
            pilot_repo if args.mode == "pilot" else None,
            limit,
            pilot_repos if args.mode in {"pilot-v2", "v3"} else None,
        )
    else:
        issues = filter_issues(issues, args.repo, None)

    if args.repo and args.mode == "v3":
        issues = [i for i in issues if i["repo"].endswith(f"/{args.repo}") or i["repo"] == args.repo]

    if not args.skip_gate and not args.dry_run and campaign == "v3":
        gate_code, gate_out = run_script("verify_harness_gate.py", ["--campaign", "v3", "--pilot-only"])
        log(gate_out)
        if gate_code != 0:
            log("Warning: harness gate failed — HAR runs may fail until harnesses are adapted")

    if not args.skip_gate and not args.dry_run and campaign != "v3":
        gate_code, gate_out = run_script("verify_harness_gate.py", ["--pilot-only"])
        log(gate_out)
        if gate_code != 0:
            log("Warning: harness gate failed — HAR runs may fail until harnesses are adapted")

    random.seed(args.seed)
    har_only = args.har_only
    if args.har_only:
        arms_default = ["har"]
    elif args.raw_only:
        arms_default = ["raw"]
    else:
        arms_default = None
    manifest = {"mode": args.mode, "campaign": campaign, "seed": args.seed, "har_only": args.har_only, "raw_only": args.raw_only, "pairs": []}
    arm_count = 1 if (args.har_only or args.raw_only) else 2
    total = len(issues) * arm_count
    done = 0
    for issue in issues:
        if arms_default:
            arms = arms_default[:]
        else:
            arms = ["raw", "har"]
        random.shuffle(arms)
        pair = {"issue": issue["issue_url"], "order": arms, "runs": []}
        for arm in arms:
            done += 1
            log(f"[{done}/{total}] Starting {issue['repo']} #{issue['issue_number']} ({arm})")
            if arm == "har" and not args.skip_gate and not args.dry_run:
                repo_id = repo_id_for_slug(issue["repo"])
                if repo_id and not repo_passes_harness_gate(repo_id):
                    log(f"  skip HAR: harness gate not passed for {repo_id}")
                    pair["runs"].append({"arm": arm, "exit_code": 1, "skipped": True, "reason": "harness gate"})
                    continue

            cmd = ["--arm", arm, "--repo", issue["repo"], "--issue-number", str(issue["issue_number"]), "--campaign", campaign]
            if args.dry_run:
                cmd.append("--dry-run")
            repo_slug = issue["repo"].split("/")[-1]
            if issue["repo"].startswith("jitsi/"):
                repo_slug = "jitsi-meet"
            else:
                for r in campaign_repos(campaign):
                    if f"{r['owner']}/{r['name']}" == issue["repo"]:
                        repo_slug = r["id"]
            existing = BENCHMARK_ROOT / "runs" / f"{repo_slug}-{issue['issue_number']}-{arm}" / "run.json"
            if not args.dry_run and existing.exists() and not args.redo_har:
                try:
                    prior = json.loads(existing.read_text(encoding="utf-8"))
                    if prior.get("status") == "completed":
                        pair["runs"].append({"arm": arm, "exit_code": 0, "skipped": True})
                        log("  skip: already completed (use --redo-har to replace)")
                        if not args.skip_evaluate:
                            run_script("evaluate_run.py", ["--run-json", str(existing), "--dry-run"])
                        continue
                except Exception:
                    pass
            code, output = run_script("run_task.py", cmd)
            run_json = None
            try:
                payload = json.loads(output.splitlines()[-1])
                run_json = Path(payload["run_dir"]) / "run.json"
            except (json.JSONDecodeError, KeyError, IndexError):
                run_json = None
            pair["runs"].append({"arm": arm, "exit_code": code, "output": output[-500:]})
            log(f"  finished exit={code}")
            if not args.skip_evaluate and run_json and run_json.exists():
                run_script("evaluate_run.py", ["--run-json", str(run_json), "--dry-run"])
        manifest["pairs"].append(pair)

    results_subdir = config.get("results_dir", "results")
    write_json(BENCHMARK_ROOT / results_subdir / f"benchmark-{args.mode}-manifest.json", manifest)
    run_script("report.py", ["--campaign", campaign] if campaign == "v3" else [])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
