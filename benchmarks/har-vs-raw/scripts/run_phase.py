#!/usr/bin/env python3
"""Run one benchmark pipeline phase independently (v3 workflow)."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BENCHMARK_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT as ROOT, load_benchmark_env, write_json  # noqa: E402
from lib.pipeline_state import (  # noqa: E402
    LogWriter,
    approval_status,
    load_state,
    log_path,
    phase_is_done,
    save_state,
    set_approval,
    set_phase_status,
    v3_config,
    v3_repo_by_id,
    v3_repos,
)

PHASE_CHOICES = [
    "fork",
    "harness-init",
    "harness-adapt",
    "harness-verify",
    "harness-push",
    "approve",
    "reject",
    "select-issues",
    "run-raw",
    "run-har",
    "report",
    "status",
]


def resolve_repos(repo_id: str | None) -> list[dict]:
    repos = v3_repos()
    if repo_id:
        repo = v3_repo_by_id(repo_id)
        if not repo:
            raise SystemExit(f"Unknown repo: {repo_id}")
        return [repo]
    return repos


def run_subprocess(script: str, args: list[str], log: LogWriter | None = None) -> int:
    cmd = [sys.executable, str(SCRIPT_DIR / script), *args]
    if log:
        log.write(f"$ {' '.join(cmd)}\n")
    proc = subprocess.Popen(
        cmd,
        cwd=BENCHMARK_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        if log:
            log.write(line)
        else:
            print(line, end="", flush=True)
    return proc.wait()


def require_approval(state: dict, repo_id: str) -> None:
    status = approval_status(state, repo_id)
    if status != "approved":
        raise RuntimeError(
            f"{repo_id}: harness not manually approved (status={status}). "
            f"Test the branch locally, then: python3 scripts/run_phase.py approve --repo {repo_id}"
        )


def phase_fork(repos: list[dict], skip_clone: bool) -> int:
    args = []
    if len(repos) == 1:
        args.extend(["--repo", repos[0]["id"]])
    if skip_clone:
        args.append("--skip-clone")
    return run_subprocess("fork_repos.py", args)


def phase_harness_init(repo: dict, state: dict) -> int:
    rid = repo["id"]
    cfg = v3_config()
    workspaces = ROOT / cfg.get("workspaces_dir", "repos")
    repo_path = workspaces / rid
    log_file = str(log_path(rid, "harness_init"))
    set_phase_status(state, rid, "harness_init", "running", log_file=log_file)
    save_state(state)

    with LogWriter(rid, "harness_init") as log:
        code = run_subprocess(
            "setup_harness.py",
            ["--repo", rid, "--skip-agent", "--skip-verify", "--campaign", "v3"],
            log,
        )
        status = "completed" if code == 0 else "failed"
        set_phase_status(state, rid, "harness_init", status, error=None if code == 0 else "har env init failed", log_file=log_file)
        save_state(state)
        return code


def phase_harness_adapt(repo: dict, state: dict, timeout_minutes: int, launch_timeout: int) -> int:
    rid = repo["id"]
    log_file = str(log_path(rid, "harness_adapt"))
    set_phase_status(state, rid, "harness_adapt", "running", log_file=log_file)
    save_state(state)

    with LogWriter(rid, "harness_adapt") as log:
        code = run_subprocess(
            "setup_harness.py",
            [
                "--repo",
                rid,
                "--campaign",
                "v3",
                "--timeout-minutes",
                str(timeout_minutes),
                "--launch-timeout-seconds",
                str(launch_timeout),
            ],
            log,
        )
        status = "completed" if code == 0 else "failed"
        set_phase_status(
            state,
            rid,
            "harness_adapt",
            status,
            error=None if code == 0 else f"setup agent exit {code}",
            log_file=log_file,
        )
        save_state(state)
        return code


def phase_harness_verify(repo: dict, state: dict, launch_timeout: int) -> int:
    rid = repo["id"]
    log_file = str(log_path(rid, "harness_verify"))
    set_phase_status(state, rid, "harness_verify", "running", log_file=log_file)
    save_state(state)

    with LogWriter(rid, "harness_verify") as log:
        code = run_subprocess(
            "verify_harness_gate.py",
            ["--repo", rid, "--campaign", "v3", "--launch-timeout-seconds", str(launch_timeout)],
            log,
        )
        status = "completed" if code == 0 else "failed"
        set_phase_status(
            state,
            rid,
            "harness_verify",
            status,
            error=None if code == 0 else "har env verify 1 --full failed",
            log_file=log_file,
        )
        save_state(state)
        return code


def phase_harness_push(repos: list[dict], force: bool) -> int:
    args = []
    if len(repos) == 1:
        args.extend(["--repo", repos[0]["id"]])
    if force:
        args.append("--force")
    return run_subprocess("push_harness_branch.py", args)


def phase_select_issues(repos: list[dict], state: dict) -> int:
    cfg = v3_config()
    failed = 0
    for repo in repos:
        rid = repo["id"]
        require_approval(state, rid)
        log_file = str(log_path(rid, "select_issues"))
        set_phase_status(state, rid, "select_issues", "running", log_file=log_file)
        save_state(state)
        with LogWriter(rid, "select_issues") as log:
            code = run_subprocess(
                "select_issues.py",
                [
                    "--repo",
                    f"{repo['upstream_owner']}/{repo['upstream_name']}",
                    "--per-repo",
                    str(cfg.get("issues_per_repo", 3)),
                    "--campaign",
                    "v3",
                ],
                log,
            )
            status = "completed" if code == 0 else "failed"
            set_phase_status(state, rid, "select_issues", status, log_file=log_file)
            save_state(state)
            if code != 0:
                failed += 1
    return 1 if failed else 0


def phase_run_arm(repos: list[dict], state: dict, arm: str) -> int:
    phase = "run_raw" if arm == "raw" else "run_har"
    cfg = v3_config()
    failed = 0
    for repo in repos:
        rid = repo["id"]
        require_approval(state, rid)
        log_file = str(log_path(rid, phase))
        set_phase_status(state, rid, phase, "running", log_file=log_file)
        save_state(state)
        with LogWriter(rid, phase) as log:
            args = ["--mode", "v3", f"--{arm}-only" if arm == "har" else "--raw-only", "--repo", rid]
            if arm == "har":
                args.append("--redo-har")
            code = run_subprocess("run_benchmark.py", args, log)
            status = "completed" if code == 0 else "failed"
            set_phase_status(state, rid, phase, status, log_file=log_file)
            save_state(state)
            if code != 0:
                failed += 1
    return 1 if failed else 0


def phase_report(state: dict) -> int:
    for repo in v3_repos():
        set_phase_status(state, repo["id"], "report", "running")
    save_state(state)
    code = run_subprocess("report.py", ["--campaign", "v3"])
    status = "completed" if code == 0 else "failed"
    for repo in v3_repos():
        set_phase_status(state, repo["id"], "report", status)
    save_state(state)
    return code


def print_status(state: dict) -> None:
    from lib.pipeline_state import campaign_summary

    summary = campaign_summary(state)
    print(f"Campaign: {state.get('campaign_id')}  updated: {state.get('updated_at')}\n")
    for rid, repo in sorted(state.get("repos", {}).items()):
        approval = repo.get("manual_approval", {}).get("status", "pending")
        branch_url = repo.get("harness_branch_url") or "-"
        print(f"## {rid} ({repo.get('slug')})  approval={approval}")
        print(f"   harness branch: {branch_url}")
        for phase, entry in repo.get("phases", {}).items():
            status = entry.get("status", "pending")
            marker = {"completed": "✓", "failed": "✗", "running": "…", "blocked": "⏸"}.get(status, "○")
            err = f" — {entry['error']}" if entry.get("error") else ""
            print(f"   {marker} {phase}: {status}{err}")
        print()
    print("Summary:", summary["by_phase"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=PHASE_CHOICES)
    parser.add_argument("--repo", help="Single repo id (default: all v3 repos)")
    parser.add_argument("--notes", default="", help="Notes for approve/reject")
    parser.add_argument("--force-push", action="store_true", help="Force-push harness branch")
    parser.add_argument("--skip-clone", action="store_true")
    parser.add_argument("--timeout-minutes", type=int, default=180)
    parser.add_argument("--launch-timeout-seconds", type=int, default=7200)
    args = parser.parse_args()

    repos = resolve_repos(args.repo)
    state = load_state()

    if args.phase == "status":
        print_status(state)
        return 0

    if args.phase == "fork":
        return phase_fork(repos, args.skip_clone)

    if args.phase == "approve":
        for repo in repos:
            set_approval(state, repo["id"], True, args.notes)
        save_state(state)
        print(f"Approved {len(repos)} repo(s). Issue-fix phases may proceed.")
        return 0

    if args.phase == "reject":
        for repo in repos:
            set_approval(state, repo["id"], False, args.notes or "rejected")
        save_state(state)
        return 0

    if args.phase == "harness-push":
        return phase_harness_push(repos, args.force_push)

    if args.phase == "select-issues":
        return phase_select_issues(repos, state)

    if args.phase == "run-raw":
        return phase_run_arm(repos, state, "raw")

    if args.phase == "run-har":
        return phase_run_arm(repos, state, "har")

    if args.phase == "report":
        return phase_report(state)

    failed = 0
    for repo in repos:
        if args.phase == "harness-init":
            failed += phase_harness_init(repo, state) != 0
        elif args.phase == "harness-adapt":
            failed += phase_harness_adapt(repo, state, args.timeout_minutes, args.launch_timeout_seconds) != 0
        elif args.phase == "harness-verify":
            failed += phase_harness_verify(repo, state, args.launch_timeout_seconds) != 0
        else:
            raise SystemExit(f"Unhandled phase: {args.phase}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
