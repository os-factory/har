#!/usr/bin/env python3
"""Pin specific GitHub issues for the benchmark (manual curation).

Use for open feature requests or issues you hand-picked. Unlike select_issues.py,
this does not require a merged fix PR or issue-specific regression test oracle.

Verification uses har env verify --full (HAR arm) or repo test suite (raw arm).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    campaign_config,
    campaign_repos,
    dump_yaml,
    github_request,
    load_benchmark_env,
    now_iso,
    run_command,
    write_json,
)


def resolve_base_commit(repo: dict, harness_branch: str) -> str:
    local = BENCHMARK_ROOT / "repos" / repo["id"]
    if local.exists():
        run_command(["git", "fetch", "origin", harness_branch], cwd=local, check=False)
        result = run_command(["git", "rev-parse", f"origin/{harness_branch}"], cwd=local, check=False)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        result = run_command(["git", "rev-parse", "HEAD"], cwd=local, check=False)
        if result.returncode == 0:
            return result.stdout.strip()
    data = github_request(f"/repos/{repo['owner']}/{repo['name']}/git/ref/heads/{harness_branch}")
    return data["object"]["sha"]


def fetch_issue(owner: str, name: str, number: int, token: str | None) -> dict:
    return github_request(f"/repos/{owner}/{name}/issues/{number}", token=token)


def build_feature_issue(
    repo: dict,
    issue: dict,
    *,
    fork_slug: str,
    base_commit: str,
    time_budget: int,
) -> dict:
    owner = repo.get("upstream_owner") or repo["owner"]
    name = repo.get("upstream_name") or repo["name"]
    number = issue["number"]
    return {
        "id": f"{owner}-{name}-{number}",
        "repo": fork_slug,
        "upstream_repo": f"{owner}/{name}",
        "owner": owner,
        "name": name,
        "issue_number": number,
        "issue_url": issue["html_url"],
        "title": issue.get("title"),
        "reference_pr": None,
        "reference_pr_number": None,
        "reference_files": [],
        "reference_test_files": [],
        "base_commit": base_commit,
        "merged_at": None,
        "verification": {
            "primary": {"type": "har_verify_full", "command": [], "cwd": None},
            "secondary_har": {"type": "har_verify_full"},
        },
        "task_type": "frontend_feature",
        "allowed_scope": ["frontend", "web", "tests"],
        "acceptance_criteria": [
            "implement the requested UI/styling behavior",
            "add or update automated tests where appropriate",
            "pass har env verify --full",
        ],
        "time_budget_minutes": time_budget,
        "frontend_relevance": "manually pinned feature/styling issue",
        "changed_files": [],
        "difficulty": 3,
        "status": "selected",
        "selection_mode": "manual_pin",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="Repo id (e.g. formbricks)")
    parser.add_argument("--issues", required=True, help="Comma-separated issue numbers")
    parser.add_argument("--campaign", choices=["default", "v3"], default="v3")
    parser.add_argument("--merge", action="store_true", help="Merge into existing issues.v3.yaml")
    parser.add_argument("--output", type=Path, help="Output path stem (.yaml)")
    args = parser.parse_args()

    numbers = [int(part.strip()) for part in args.issues.split(",") if part.strip()]
    env = load_benchmark_env()
    token = env.get("GITHUB_TOKEN")
    config = campaign_config(args.campaign)
    repos = campaign_repos(args.campaign)
    repo = next((r for r in repos if r["id"] == args.repo), None)
    if not repo:
        raise SystemExit(f"Unknown repo id: {args.repo}")

    harness_branch = config.get("harness_branch", "benchmark/har-setup")
    fork_slug = f"{repo['owner']}/{repo['name']}"
    owner = repo.get("upstream_owner") or repo["owner"]
    name = repo.get("upstream_name") or repo["name"]
    base_commit = resolve_base_commit(repo, harness_branch)
    time_budget = config.get("time_budget_minutes", 90)

    pinned: list[dict] = []
    for number in numbers:
        issue = fetch_issue(owner, name, number, token)
        if issue.get("pull_request"):
            print(f"Warning: #{number} is a PR, skipping", file=sys.stderr)
            continue
        pinned.append(
            build_feature_issue(repo, issue, fork_slug=fork_slug, base_commit=base_commit, time_budget=time_budget)
        )
        print(f"Pinned #{number}: {issue.get('title', '')[:70]}")

    out_path = args.output or BENCHMARK_ROOT / "issues.v3.yaml"
    existing: list[dict] = []
    if args.merge and out_path.exists():
        from lib.common import load_yaml

        data = load_yaml(out_path)
        existing = [i for i in data.get("issues", []) if i.get("repo") != fork_slug]
    payload = {
        "version": 3,
        "generated_at": now_iso(),
        "issues": existing + pinned,
    }
    dump_yaml(out_path, payload)
    write_json(Path(str(out_path).replace(".yaml", ".json")), payload)
    print(f"Wrote {len(pinned)} issue(s) to {out_path} (base_commit={base_commit[:12]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
