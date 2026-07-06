#!/usr/bin/env python3
"""Build issues.yaml from issues.seed.yaml without GitHub REST metadata calls."""

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
    load_yaml,
    resolve_base_commit_before_date,
    write_json,
)


def build_issue(repo: dict, entry: dict) -> dict:
    owner = repo["owner"]
    name = repo["name"]
    number = entry["issue_number"]
    closed_at = entry["closed_at"]
    base_commit = resolve_base_commit_before_date(
        repo["url"], closed_at, entry.get("branch", repo.get("default_branch", "main"))
    )
    return {
        "id": f"{owner}-{name}-{number}",
        "repo": f"{owner}/{name}",
        "owner": owner,
        "name": name,
        "issue_number": number,
        "issue_url": f"https://github.com/{owner}/{name}/issues/{number}",
        "title": entry.get("title"),
        "reference_pr": entry.get("reference_pr"),
        "base_commit": base_commit,
        "merged_at": closed_at,
        "task_type": "frontend_bugfix",
        "allowed_scope": ["frontend", "web", "tests"],
        "acceptance_criteria": [
            "reproduce issue",
            "fix behavior",
            "add or update browser-facing regression test when useful",
        ],
        "time_budget_minutes": benchmark_config().get("time_budget_minutes", 90),
        "frontend_relevance": entry.get("frontend_relevance", "seed-selected frontend/UI issue"),
        "status": "selected",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="Only import one repo slug")
    args = parser.parse_args()

    seed = load_yaml(BENCHMARK_ROOT / "issues.seed.yaml")["issues"]
    repo_by_slug = {f"{r['owner']}/{r['name']}": r for r in benchmark_repos()}

    issues = []
    for repo_slug, entries in seed.items():
        if args.repo and repo_slug != args.repo and not repo_slug.endswith(f"/{args.repo}"):
            continue
        repo = repo_by_slug.get(repo_slug)
        if not repo:
            raise SystemExit(f"Unknown repo in seed: {repo_slug}")
        print(f"Importing {repo_slug} ({len(entries)} issues)...")
        for entry in entries:
            try:
                issues.append(build_issue(repo, entry))
                print(f"  #{entry['issue_number']} -> {issues[-1]['base_commit'][:12]}")
            except Exception as exc:  # noqa: BLE001
                print(f"  failed #{entry['issue_number']}: {exc}")

    payload = {
        "version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "issues": issues,
    }
    dump_yaml(BENCHMARK_ROOT / "issues.yaml", payload)
    write_json(BENCHMARK_ROOT / "issues.json", payload)
    print(f"Wrote {len(issues)} issues")
    return 0 if len(issues) >= 40 else 1


if __name__ == "__main__":
    raise SystemExit(main())
