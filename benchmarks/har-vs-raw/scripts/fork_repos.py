#!/usr/bin/env python3
"""Fork upstream repositories into the os-factory organization."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import github_request, load_benchmark_env, run_command, write_json  # noqa: E402
from lib.pipeline_state import (  # noqa: E402
    LogWriter,
    load_state,
    log_path,
    save_state,
    set_phase_status,
    v3_config,
    v3_repo_by_id,
    v3_repos,
)


def fork_exists(org: str, name: str, token: str | None) -> bool:
    try:
        github_request(f"/repos/{org}/{name}", token=token)
        return True
    except RuntimeError as exc:
        if "404" in str(exc):
            return False
        raise


def fork_upstream_gh(repo: dict, org: str) -> dict:
    upstream = f"{repo['upstream_owner']}/{repo['upstream_name']}"
    fork_slug = f"{org}/{repo['name']}"
    if run_command(["gh", "repo", "view", fork_slug]).returncode == 0:
        return {"action": "exists", "url": repo["url"], "tool": "gh"}
    result = run_command(["gh", "repo", "fork", upstream, "--org", org, "--clone=false"], check=True)
    url = result.stdout.strip() or repo["url"]
    return {"action": "created", "url": url, "tool": "gh"}


def fork_upstream(repo: dict, org: str, token: str | None) -> dict:
    if shutil.which("gh"):
        return fork_upstream_gh(repo, org)
    upstream_owner = repo["upstream_owner"]
    upstream_name = repo["upstream_name"]
    if fork_exists(org, repo["name"], token):
        return {"action": "exists", "url": repo["url"]}
    payload: dict = {"default_branch_only": True}
    if org:
        payload["organization"] = org
    result = github_request(
        f"/repos/{upstream_owner}/{upstream_name}/forks",
        token=token,
        method="POST",
        body=payload,
    )
    return {"action": "created", "url": result.get("html_url"), "full_name": result.get("full_name")}


def sync_fork_default_branch(repo: dict, workspaces_dir: Path, token: str | None) -> Path:
    """Clone or update the os-factory fork locally."""
    target = workspaces_dir / repo["id"]
    branch = repo.get("default_branch", "main")
    if target.exists():
        run_command(["git", "fetch", "origin", branch], cwd=target, check=False)
        run_command(["git", "checkout", branch], cwd=target, check=False)
        run_command(["git", "pull", "--ff-only", "origin", branch], cwd=target, check=False)
        return target
    run_command(
        ["git", "clone", "--branch", branch, "--single-branch", repo["url"], str(target)],
        check=True,
    )
    upstream = f"https://github.com/{repo['upstream_owner']}/{repo['upstream_name']}.git"
    run_command(["git", "remote", "add", "upstream", upstream], cwd=target, check=False)
    return target


def run_fork_phase(repo_id: str | None, skip_clone: bool) -> int:
    env = load_benchmark_env()
    token = env.get("GITHUB_TOKEN")
    cfg = v3_config()
    org = cfg.get("fork_org", "os-factory")
    workspaces_dir = Path(__file__).resolve().parents[1] / cfg.get("workspaces_dir", "repos")

    repos = v3_repos()
    if repo_id:
        repo = v3_repo_by_id(repo_id)
        if not repo:
            raise SystemExit(f"Unknown repo: {repo_id}")
        repos = [repo]

    state = load_state()
    failed = 0
    summary = []

    for repo in repos:
        rid = repo["id"]
        log_file = str(log_path(rid, "fork"))
        set_phase_status(state, rid, "fork", "running", log_file=log_file)
        save_state(state)

        with LogWriter(rid, "fork") as log:
            log.write(f"Forking {repo['upstream_owner']}/{repo['upstream_name']} -> {org}/{repo['name']}\n")
            try:
                fork_result = fork_upstream(repo, org, token)
                log.write(f"Fork result: {fork_result}\n")
                set_phase_status(state, rid, "fork", "completed", log_file=log_file)
                if not skip_clone:
                    set_phase_status(state, rid, "clone", "running", log_file=str(log_path(rid, "clone")))
                    save_state(state)
                    path = sync_fork_default_branch(repo, workspaces_dir, token)
                    log.write(f"Local clone: {path}\n")
                    set_phase_status(state, rid, "clone", "completed", log_file=str(log_path(rid, "clone")))
                summary.append({"repo_id": rid, "fork": fork_result, "ok": True})
            except Exception as exc:  # noqa: BLE001
                log.write(f"ERROR: {exc}\n")
                set_phase_status(state, rid, "fork", "failed", error=str(exc), log_file=log_file)
                summary.append({"repo_id": rid, "ok": False, "error": str(exc)})
                failed += 1
        save_state(state)

    write_json(Path(__file__).resolve().parents[1] / cfg.get("results_dir", "results/v3") / "fork-summary.json", summary)
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="Single repo id")
    parser.add_argument("--skip-clone", action="store_true", help="Only fork on GitHub; do not clone locally")
    args = parser.parse_args()
    return run_fork_phase(args.repo, args.skip_clone)


if __name__ == "__main__":
    raise SystemExit(main())
