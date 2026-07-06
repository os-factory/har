#!/usr/bin/env python3
"""Extract or refresh verification oracles for issues in issues.yaml."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    benchmark_repos,
    build_verification_block,
    dump_yaml,
    extract_test_files_from_pr,
    github_pull_file_details,
    load_yaml,
    write_json,
)


def repo_for_issue(issue: dict, repos: list[dict]) -> dict | None:
    for repo in repos:
        if issue["repo"] == f"{repo['owner']}/{repo['name']}":
            return repo
    return None


def enrich_verification(issue: dict, repo: dict, token: str | None) -> dict | None:
    pull_number = issue.get("reference_pr_number")
    if not pull_number:
        return None
    owner, name = repo["owner"], repo["name"]
    file_details = github_pull_file_details(owner, name, pull_number, token=token)
    test_files = extract_test_files_from_pr(file_details)
    return build_verification_block(repo, test_files)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--issues", type=Path, default=BENCHMARK_ROOT / "issues.yaml")
    args = parser.parse_args()

    from lib.common import load_benchmark_env

    token = load_benchmark_env().get("GITHUB_TOKEN")
    payload = load_yaml(args.issues)
    repos = benchmark_repos()
    updated = 0
    for issue in payload.get("issues", []):
        repo = repo_for_issue(issue, repos)
        if not repo:
            continue
        verification = enrich_verification(issue, repo, token)
        if verification:
            issue["verification"] = verification
            updated += 1
    dump_yaml(args.issues, payload)
    write_json(BENCHMARK_ROOT / "issues.json", payload)
    print(f"Updated verification for {updated} issues")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
