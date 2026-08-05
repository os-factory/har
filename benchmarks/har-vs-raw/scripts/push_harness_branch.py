#!/usr/bin/env python3
"""Push adapted .har harness to the benchmark branch on the os-factory fork."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import run_command, write_json  # noqa: E402
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


def repo_path(repo: dict, workspaces_dir: Path) -> Path:
    return workspaces_dir / repo["id"]


def has_har_changes(repo_path: Path) -> bool:
    if not (repo_path / ".har").exists():
        return False
    result = run_command(["git", "status", "--porcelain", ".har", "AGENTS.md"], cwd=repo_path)
    return bool(result.stdout.strip())


def push_harness_branch(repo: dict, workspaces_dir: Path, branch: str, force: bool) -> dict:
    path = repo_path(repo, workspaces_dir)
    if not path.exists():
        raise RuntimeError(f"Repo not cloned at {path}. Run: python3 scripts/run_phase.py fork --repo {repo['id']}")

    if not (path / ".har" / "launch.sh").exists():
        raise RuntimeError(f"No .har harness in {path}. Run harness-adapt first.")

    default_branch = repo.get("default_branch", "main")
    run_command(["git", "fetch", "origin"], cwd=path, check=False)

    # Stash or commit harness files on a dedicated branch
    status = run_command(["git", "status", "--porcelain"], cwd=path)
    if status.stdout.strip():
        run_command(["git", "add", ".har", "AGENTS.md", "playwright.config.js", "tests"], cwd=path, check=False)
        run_command(
            ["git", "commit", "-m", "chore(.har): benchmark harness setup"],
            cwd=path,
            check=False,
        )

    # Create or checkout benchmark branch from current HEAD
    exists = run_command(["git", "show-ref", "--verify", f"refs/heads/{branch}"], cwd=path)
    if exists.returncode == 0:
        run_command(["git", "checkout", branch], cwd=path, check=True)
    else:
        run_command(["git", "checkout", "-B", branch], cwd=path, check=True)

    push_args = ["git", "push", "-u", "origin", branch]
    if force:
        push_args.insert(2, "--force")
    push = run_command(push_args, cwd=path)
    if push.returncode != 0:
        raise RuntimeError(push.stderr or push.stdout)

    url = f"{repo['url']}/tree/{branch}"
    return {"branch": branch, "url": url, "default_branch": default_branch}


def run_push_phase(repo_id: str | None, force: bool) -> int:
    cfg = v3_config()
    branch = cfg.get("harness_branch", "benchmark/har-setup")
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
        log_file = str(log_path(rid, "harness_push"))
        set_phase_status(state, rid, "harness_push", "running", log_file=log_file)
        save_state(state)

        with LogWriter(rid, "harness_push") as log:
            log.write(f"Pushing harness branch {branch} for {repo['owner']}/{repo['name']}\n")
            try:
                result = push_harness_branch(repo, workspaces_dir, branch, force)
                log.write(f"Pushed: {result['url']}\n")
                repo_state = state["repos"][rid]
                repo_state["harness_branch_url"] = result["url"]
                set_phase_status(state, rid, "harness_push", "completed", log_file=log_file)
                set_phase_status(state, rid, "harness_approval", "blocked", log_file=log_file)
                repo_state["manual_approval"]["status"] = "pending"
                summary.append({"repo_id": rid, **result, "ok": True})
            except Exception as exc:  # noqa: BLE001
                log.write(f"ERROR: {exc}\n")
                set_phase_status(state, rid, "harness_push", "failed", error=str(exc), log_file=log_file)
                summary.append({"repo_id": rid, "ok": False, "error": str(exc)})
                failed += 1
        save_state(state)

    write_json(Path(__file__).resolve().parents[1] / cfg.get("results_dir", "results/v3") / "push-summary.json", summary)
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="Single repo id")
    parser.add_argument("--force", action="store_true", help="Force-push harness branch")
    args = parser.parse_args()
    return run_push_phase(args.repo, args.force)


if __name__ == "__main__":
    raise SystemExit(main())
