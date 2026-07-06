#!/usr/bin/env python3
"""Search GitHub and curate verifiable frontend issue replay candidates."""

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
    build_verification_block,
    dump_yaml,
    extract_test_files_from_pr,
    find_closing_pull,
    frontend_file_ratio,
    github_pull_file_details,
    github_search_issues,
    is_frontend_issue,
    is_reproducible_issue,
    load_benchmark_env,
    now_iso,
    pr_within_scope,
    write_json,
)

SEARCH_QUERIES = [
    "label:bug (frontend OR ui OR browser OR react OR css)",
    "label:bug (routing OR dashboard OR toggle OR chart OR table)",
    "is:closed bug ui in:title",
    "is:closed label:bug test in:title",
]


def enrich_issue(owner: str, repo: dict, issue: dict, token: str | None, *, fork_slug: str | None = None) -> dict | None:
    name = repo["name"]
    number = issue["number"]
    if not is_reproducible_issue(issue):
        return None
    pull = find_closing_pull(owner, name, number, token=token)
    if not pull:
        return None
    base_commit = base_commit_before_merge(owner, name, pull, token=token)
    if not base_commit:
        return None
    file_details = github_pull_file_details(owner, name, pull["number"], token=token)
    files = [item["filename"] for item in file_details]
    if not pr_within_scope(file_details):
        return None
    if frontend_file_ratio(files, repo) < 0.6:
        return None
    test_files = extract_test_files_from_pr(file_details)
    if not test_files:
        return None
    verification = build_verification_block(repo, test_files)
    if not verification:
        return None
    non_test_files = [path for path in files if path not in test_files]
    return {
        "id": f"{owner}-{name}-{number}",
        "repo": fork_slug or f"{owner}/{name}",
        "upstream_repo": f"{owner}/{name}",
        "owner": owner,
        "name": name,
        "issue_number": number,
        "issue_url": issue["html_url"],
        "title": issue.get("title"),
        "reference_pr": pull["html_url"],
        "reference_pr_number": pull["number"],
        "reference_files": non_test_files[:20] or files[:20],
        "reference_test_files": test_files,
        "base_commit": base_commit,
        "merged_at": pull.get("merged_at"),
        "verification": verification,
        "task_type": "frontend_bugfix",
        "allowed_scope": ["frontend", "web", "tests"],
        "acceptance_criteria": [
            "reproduce issue",
            "fix behavior",
            "pass issue-specific regression test",
        ],
        "time_budget_minutes": benchmark_config().get("time_budget_minutes", 45),
        "frontend_relevance": "auto-selected verifiable frontend issue with merged fix PR and test oracle",
        "changed_files": files[:20],
        "difficulty": 3,
        "status": "candidate",
    }


def select_for_repo(repo: dict, per_repo: int, token: str | None, *, campaign: str = "default") -> list[dict]:
    owner = repo.get("upstream_owner") or repo["owner"]
    name = repo.get("upstream_name") or repo["name"]
    fork_slug = f"{repo['owner']}/{repo['name']}" if campaign == "v3" else None
    print(f"Searching {owner}/{name}...")
    selected: list[dict] = []
    seen_numbers: set[int] = set()
    for query in SEARCH_QUERIES:
        if len(selected) >= per_repo:
            break
        try:
            items = github_search_issues(owner, name, query, token=token)
        except RuntimeError as exc:
            print(f"  search stopped ({exc})")
            break
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
                enriched = enrich_issue(owner, repo, issue, token, fork_slug=fork_slug)
            except Exception as exc:  # noqa: BLE001
                print(f"  skip #{number}: {exc}")
                continue
            if not enriched:
                print(f"  skip #{number}: failed v2 filters (PR/tests/scope)")
                continue
            selected.append(enriched)
            oracle = enriched["verification"]["primary"]["command"]
            print(f"  selected #{number}: {issue.get('title', '')[:60]}")
            print(f"    oracle: {' '.join(oracle)}")
            time.sleep(0.5)
    return selected


def print_review_table(issues: list[dict]) -> None:
    print("\nCandidate review table:")
    print("-" * 100)
    for issue in issues:
        oracle = " ".join(issue["verification"]["primary"]["command"])
        print(
            f"{issue['repo']} #{issue['issue_number']} | PR {issue['reference_pr_number']} | "
            f"oracle: {oracle[:70]}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--per-repo", type=int, default=benchmark_config().get("issues_per_repo", 5))
    parser.add_argument("--limit", type=int, help="Alias for --per-repo")
    parser.add_argument("--repo", help="Only curate one repo id or owner/name")
    parser.add_argument("--campaign", choices=["default", "v3"], default="default")
    parser.add_argument("--pilot-only", action="store_true", help="Only curate pilot repos from config")
    parser.add_argument("--write-candidates", action="store_true", help="Write issues.candidates.yaml")
    parser.add_argument("--output", type=Path, help="Write issues YAML/JSON to custom path stem")
    args = parser.parse_args()
    per_repo = args.limit or args.per_repo

    env = load_benchmark_env()
    token = env.get("GITHUB_TOKEN")
    if not token:
        print("Warning: GITHUB_TOKEN not set — API rate limits may block curation", file=sys.stderr)

    from lib.common import campaign_config, campaign_repos  # noqa: E402

    config = campaign_config(args.campaign)
    repos = campaign_repos(args.campaign)
    if args.pilot_only:
        pilot_repos = config.get("pilot_repos") or [config["pilot"]["repo"]]
        repos = [r for r in repos if f"{r['owner']}/{r['name']}" in pilot_repos or r["id"] in pilot_repos]
    if args.repo:
        repos = [r for r in repos if r["id"] == args.repo or f"{r['owner']}/{r['name']}" == args.repo]
        if not repos:
            raise SystemExit(f"Unknown repo: {args.repo}")

    all_issues: list[dict] = []
    for repo in repos:
        all_issues.extend(select_for_repo(repo, per_repo, token, campaign=args.campaign))

    print_review_table(all_issues)
    payload = {
        "version": 3 if args.campaign == "v3" else 2,
        "generated_at": now_iso(),
        "issues": [{**issue, "status": "selected"} for issue in all_issues],
    }
    if args.campaign == "v3":
        issues_path = args.output or BENCHMARK_ROOT / "issues.v3.yaml"
        dump_yaml(issues_path, payload)
        write_json(Path(str(issues_path).replace(".yaml", ".json")), payload)
    elif args.output:
        dump_yaml(Path(str(args.output)), payload)
        write_json(Path(str(args.output).replace(".yaml", ".json")), payload)
    else:
        dump_yaml(BENCHMARK_ROOT / "issues.yaml", payload)
        write_json(BENCHMARK_ROOT / "issues.json", payload)
        if args.pilot_only:
            dump_yaml(BENCHMARK_ROOT / "issues.pilot.yaml", payload)
            write_json(BENCHMARK_ROOT / "issues.pilot.json", payload)
    if args.write_candidates:
        dump_yaml(BENCHMARK_ROOT / "issues.candidates.yaml", payload)
    print(f"Wrote {len(all_issues)} issues to {issues_path}")
    return 0 if all_issues else 1


if __name__ == "__main__":
    raise SystemExit(main())
