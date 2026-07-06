#!/usr/bin/env python3
"""Initialize and adapt HAR harnesses for benchmark repositories."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    HAR_PROJECT_ROOT,
    benchmark_repos,
    load_benchmark_env,
    render_template,
    run_command,
    write_json,
)

SETUP_PROMPT = BENCHMARK_ROOT / "prompts" / "setup-har.md"


def repo_workspace(repo: dict, workspaces_dir: Path) -> Path:
    return workspaces_dir / repo["id"]


def clone_repo(repo: dict, workspaces_dir: Path) -> Path:
    target = repo_workspace(repo, workspaces_dir)
    if target.exists():
        return target
    run_command(["git", "clone", "--depth", "1", repo["url"], str(target)], check=True)
    return target


def har_init(repo_path: Path) -> None:
    if (repo_path / ".har" / "launch.sh").exists():
        return
    run_command(["har", "env", "init", "--profile", "default"], cwd=repo_path, check=True)
    run_command(["har", "env", "add-stage", "playwright"], cwd=repo_path, check=True)


def run_setup_agent(repo_path: Path, repo: dict, env: dict[str, str], timeout_minutes: int) -> dict:
    prompt = render_template(
        SETUP_PROMPT,
        {"owner": repo["owner"], "name": repo["name"]},
    )
    started = time.time()
    result = run_command(
        [
            "claude",
            "-p",
            prompt,
            "--dangerously-skip-permissions",
            "--output-format",
            "json",
        ],
        cwd=repo_path,
        env=env,
        timeout=timeout_minutes * 60,
    )
    return {
        "exit_code": result.returncode,
        "stdout": result.stdout[-8000:],
        "stderr": result.stderr[-8000:],
        "wall_clock_seconds": round(time.time() - started, 2),
    }


def verify_harness(repo_path: Path) -> dict:
    launch = run_command(["har", "env", "launch", "1", "--force"], cwd=repo_path)
    verify = run_command(["har", "env", "verify", "1"], cwd=repo_path)
    verify_full = run_command(["har", "env", "verify", "1", "--full"], cwd=repo_path)
    return {
        "launch_exit_code": launch.returncode,
        "verify_exit_code": verify.returncode,
        "verify_full_exit_code": verify_full.returncode,
        "launch_stdout": launch.stdout[-4000:],
        "verify_full_stdout": verify_full.stdout[-4000:],
    }


def build_telemetry_env(base_env: dict[str, str], repo: dict, phase: str) -> dict[str, str]:
    env = dict(base_env)
    env["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1"
    env["OTEL_TRACES_EXPORTER"] = "otlp"
    env["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"] = "1"
    env["CLAUDE_CODE_OTEL_DIAG_STDERR"] = "1"
    host = base_env.get("LANGFUSE_HOST", "http://localhost:3300")
    if base_env.get("LANGFUSE_PUBLIC_KEY") and base_env.get("LANGFUSE_SECRET_KEY"):
        from lib.common import langfuse_auth_header

        env["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf"
        env["OTEL_EXPORTER_OTLP_ENDPOINT"] = f"{host.rstrip('/')}/api/public/otel"
        env["OTEL_EXPORTER_OTLP_HEADERS"] = langfuse_auth_header(
            base_env["LANGFUSE_PUBLIC_KEY"], base_env["LANGFUSE_SECRET_KEY"]
        )
    env["HAR_BENCHMARK_PHASE"] = phase
    env["HAR_BENCHMARK_REPO"] = f"{repo['owner']}/{repo['name']}"
    return env


def setup_one(repo: dict, workspaces_dir: Path, env: dict[str, str], skip_agent: bool, timeout_minutes: int) -> dict:
    started = time.time()
    repo_path = clone_repo(repo, workspaces_dir)
    har_init(repo_path)
    agent_result = None
    if not skip_agent:
        agent_result = run_setup_agent(repo_path, repo, build_telemetry_env(env, repo, "harness-setup"), timeout_minutes)
    verification = verify_harness(repo_path)
    record = {
        "repo": f"{repo['owner']}/{repo['name']}",
        "repo_id": repo["id"],
        "repo_path": str(repo_path),
        "harness_setup_seconds": round(time.time() - started, 2),
        "agent_result": agent_result,
        "verification": verification,
        "passed": verification["verify_full_exit_code"] == 0,
    }
    write_json(BENCHMARK_ROOT / "results" / "harness-setup" / f"{repo['id']}.json", record)
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="Setup one repo id or owner/name")
    parser.add_argument("--skip-agent", action="store_true", help="Only run har env init/add-stage")
    parser.add_argument("--timeout-minutes", type=int, default=120)
    args = parser.parse_args()

    env = load_benchmark_env()
    workspaces_dir = BENCHMARK_ROOT / "repos"
    repos = benchmark_repos()
    if args.repo:
        repos = [r for r in repos if r["id"] == args.repo or f"{r['owner']}/{r['name']}" == args.repo]
        if not repos:
            raise SystemExit(f"Unknown repo: {args.repo}")

    summary = []
    for repo in repos:
        print(f"Setting up harness for {repo['owner']}/{repo['name']}...")
        summary.append(setup_one(repo, workspaces_dir, env, args.skip_agent, args.timeout_minutes))
    write_json(BENCHMARK_ROOT / "results" / "harness-setup-summary.json", summary)
    passed = sum(1 for item in summary if item["passed"])
    print(f"Harness setup complete: {passed}/{len(summary)} passed full verify")
    return 0 if passed == len(summary) else 1


if __name__ == "__main__":
    raise SystemExit(main())
