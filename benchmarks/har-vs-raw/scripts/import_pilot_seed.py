#!/usr/bin/env python3
"""Build pilot issues.yaml from issues.pilot.seed.yaml with git-resolved base commits."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    benchmark_config,
    benchmark_repos,
    dump_yaml,
    find_closing_pull,
    load_benchmark_env,
    load_yaml,
    now_iso,
    resolve_base_commit_before_date,
    write_json,
)


def build_issue(repo: dict, entry: dict, token: str | None) -> dict:
    owner, name = repo["owner"], repo["name"]
    number = entry["issue_number"]
    closed_at = entry["closed_at"]
    base_commit = resolve_base_commit_before_date(
        repo["url"], closed_at, entry.get("branch", repo.get("default_branch", "main"))
    )
    reference_pr = None
    reference_pr_number = entry.get("reference_pr_number")
    if token and not reference_pr_number:
        pull = find_closing_pull(owner, name, number, token=token)
        if pull:
            reference_pr_number = pull["number"]
            reference_pr = pull["html_url"]
            base_commit = base_commit or pull.get("base", {}).get("sha")
    if reference_pr_number and not reference_pr:
        reference_pr = f"https://github.com/{owner}/{name}/pull/{reference_pr_number}"

    verification = entry.get("verification") or {}
    if not verification.get("secondary_har"):
        verification = {**verification, "secondary_har": {"type": "har_verify_full"}}

    return {
        "id": f"{owner}-{name}-{number}",
        "repo": f"{owner}/{name}",
        "owner": owner,
        "name": name,
        "issue_number": number,
        "issue_url": f"https://github.com/{owner}/{name}/issues/{number}",
        "title": entry.get("title"),
        "reference_pr": reference_pr,
        "reference_pr_number": reference_pr_number,
        "reference_files": entry.get("reference_files") or [],
        "reference_test_files": entry.get("reference_test_files") or [],
        "verification": verification,
        "base_commit": base_commit,
        "merged_at": closed_at,
        "task_type": "frontend_bugfix",
        "allowed_scope": ["frontend", "web", "tests"],
        "acceptance_criteria": ["reproduce issue", "fix behavior", "pass issue-specific regression test"],
        "time_budget_minutes": benchmark_config().get("time_budget_minutes", 45),
        "frontend_relevance": "pilot-seed verifiable frontend issue",
        "status": "selected",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=Path, default=BENCHMARK_ROOT / "issues.pilot.seed.yaml")
    args = parser.parse_args()

    seed = load_yaml(args.seed)["issues"]
    repo_by_slug = {f"{r['owner']}/{r['name']}": r for r in benchmark_repos()}
    token = load_benchmark_env().get("GITHUB_TOKEN")

    issues = []
    for repo_slug, entries in seed.items():
        repo = repo_by_slug.get(repo_slug)
        if not repo:
            raise SystemExit(f"Unknown repo: {repo_slug}")
        print(f"Importing {repo_slug}...")
        for entry in entries:
            if entry.get("skip"):
                continue
            try:
                issue = build_issue(repo, entry, token)
                issues.append(issue)
                print(f"  #{entry['issue_number']} -> {issue['base_commit'][:12]}")
            except Exception as exc:  # noqa: BLE001
                print(f"  failed #{entry['issue_number']}: {exc}")
            time.sleep(0.2)

    payload = {"version": 2, "generated_at": now_iso(), "issues": issues}
    dump_yaml(BENCHMARK_ROOT / "issues.yaml", payload)
    dump_yaml(BENCHMARK_ROOT / "issues.pilot.yaml", payload)
    write_json(BENCHMARK_ROOT / "issues.json", payload)
    write_json(BENCHMARK_ROOT / "issues.pilot.json", payload)
    print(f"Wrote {len(issues)} pilot issues")
    return 0 if len(issues) == 15 else 1


if __name__ == "__main__":
    raise SystemExit(main())
