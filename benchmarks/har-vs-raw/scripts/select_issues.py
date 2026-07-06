#!/usr/bin/env python3
"""Search GitHub and curate frontend issue replay candidates."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    base_commit_before_merge,
    benchmark_config,
    benchmark_repos,
    dump_yaml,
    find_closing_pull,
    github_pull_files,
    github_search_issues,
    is_frontend_issue,
    load_benchmark_env,
    write_json,
)

SEARCH_QUERIES = [
    "label:bug (frontend OR ui OR browser OR react OR css)",
    "label:bug (routing OR dashboard OR toggle OR chart OR table)",
    "is:closed bug ui in:title",
]


def enrich_issue(owner: str, repo: str, issue: dict, token: str | None) -> dict | None:
    number = issue["number"]
    pull = find_closing_pull(owner, repo, number, token=token)
    if not pull:
        return None
    base_commit = base_commit_before_merge(owner, repo, pull, token=token)
    if not base_commit:
        return None
    files = github_pull_files(owner, repo, pull["number"], token=token)
    return {
        "id": f"{owner}-{repo}-{number}",
        "repo": f"{owner}/{repo}",
        "owner": owner,
        "name": repo,
        "issue_number": number,
        "issue_url": issue["html_url"],
        "title": issue.get("title"),
        "reference_pr": pull["html_url"],
        "reference_pr_number": pull["number"],
        "base_commit": base_commit,
        "merged_at": pull.get("merged_at"),
        "task_type": "frontend_bugfix",
        "allowed_scope": ["frontend", "web", "tests"],
        "acceptance_criteria": [
            "reproduce issue",
            "fix behavior",
            "add or update browser-facing regression test when useful",
        ],
        "time_budget_minutes": benchmark_config().get("time_budget_minutes", 90),
        "frontend_relevance": "auto-selected frontend/UI issue with merged fix PR",
        "changed_files": files[:20],
        "difficulty": 3,
        "status": "candidate",
    }


def select_for_repo(repo: dict, per_repo: int, token: str | None) -> list[dict]:
    owner = repo["owner"]
    name = repo["name"]
    print(f"Searching {owner}/{name}...")
    selected: list[dict] = []
    seen_numbers: set[int] = set()
    for query in SEARCH_QUERIES:
        if len(selected) >= per_repo:
            break
        items = github_search_issues(owner, name, query, token=token)
        for issue in items:
            if len(selected) >= per_repo:
                break
            if issue.get("pull_request"):
                continue
            if not is_frontend_issue(issue):
                continue
            number = issue["number"]
            if number in seen_numbers:
                continue
            seen_numbers.add(number)
            try:
                enriched = enrich_issue(owner, name, issue, token)
            except Exception as exc:  # noqa: BLE001
                print(f"  skip #{number}: {exc}")
                continue
            if not enriched:
                print(f"  skip #{number}: no merged closing PR/base commit")
                continue
            selected.append(enriched)
            print(f"  selected #{number}: {issue.get('title', '')[:80]}")
            time.sleep(0.5)
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--per-repo", type=int, default=benchmark_config().get("issues_per_repo", 5))
    parser.add_argument("--repo", help="Only curate one repo id or owner/name")
    parser.add_argument("--write-candidates", action="store_true", help="Write issues.candidates.yaml")
    args = parser.parse_args()

    env = load_benchmark_env()
    token = env.get("GITHUB_TOKEN")
    repos = benchmark_repos()
    if args.repo:
        repos = [r for r in repos if r["id"] == args.repo or f"{r['owner']}/{r['name']}" == args.repo]
        if not repos:
            raise SystemExit(f"Unknown repo: {args.repo}")

    all_issues: list[dict] = []
    for repo in repos:
        all_issues.extend(select_for_repo(repo, args.per_repo, token))

    payload = {
        "version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "issues": [{**issue, "status": "selected"} for issue in all_issues],
    }
    dump_yaml(BENCHMARK_ROOT / "issues.yaml", payload)
    write_json(BENCHMARK_ROOT / "issues.json", payload)
    if args.write_candidates:
        dump_yaml(BENCHMARK_ROOT / "issues.candidates.yaml", payload)
    print(f"Wrote {len(all_issues)} issues to {BENCHMARK_ROOT / 'issues.yaml'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
