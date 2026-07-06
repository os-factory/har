#!/usr/bin/env python3
"""Run one benchmark attempt (raw or har) with identical issue-fix prompt."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
import uuid
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    HAR_PROJECT_ROOT,
    benchmark_config,
    benchmark_issues,
    benchmark_repos,
    ensure_dir,
    langfuse_auth_header,
    load_benchmark_env,
    now_iso,
    render_template,
    run_command,
    slugify,
    write_json,
)

FIX_PROMPT = BENCHMARK_ROOT / "prompts" / "fix-issue.md"


def repo_meta(repo_slug: str) -> dict:
    for repo in benchmark_repos():
        if f"{repo['owner']}/{repo['name']}" == repo_slug or repo["id"] == repo_slug:
            return repo
    raise SystemExit(f"Unknown repo: {repo_slug}")


def issue_meta(issue_id: str | None, repo_slug: str, issue_number: int | None) -> dict:
    issues = benchmark_issues()
    if issue_id:
        for issue in issues:
            if issue.get("id") == issue_id:
                return issue
    if issue_number is not None:
        for issue in issues:
            if issue["repo"] == repo_slug and issue["issue_number"] == issue_number:
                return issue
    raise SystemExit("Issue not found in issues.yaml")


def workspace_dir(arm: str, repo: dict, issue: dict) -> Path:
    cfg = benchmark_config()
    base = BENCHMARK_ROOT / cfg.get("runs_dir", "runs")
    run_key = slugify(f"{repo['id']}-{issue['issue_number']}-{arm}")
    return ensure_dir(base / run_key)


def prepare_repo(source_repo: dict, issue: dict, arm: str, dest: Path) -> Path:
    if dest.exists():
        shutil.rmtree(dest)
    run_command(["git", "clone", source_repo["url"], str(dest)], check=True)
    run_command(["git", "checkout", issue["base_commit"]], cwd=dest, check=True)

    har_paths = [
        dest / ".har",
        dest / ".cursor" / "rules" / "har-workflow.mdc",
    ]
    if arm == "raw":
        for path in har_paths:
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()
        return dest

    harness_src = BENCHMARK_ROOT / "repos" / source_repo["id"] / ".har"
    if harness_src.exists():
        shutil.copytree(harness_src, dest / ".har")
    agent_md = BENCHMARK_ROOT / "repos" / source_repo["id"] / "AGENT.md"
    if agent_md.exists():
        shutil.copy2(agent_md, dest / "AGENT.md")
    cursor_rule = BENCHMARK_ROOT / "repos" / source_repo["id"] / ".cursor" / "rules" / "har-workflow.mdc"
    if cursor_rule.exists():
        ensure_dir(dest / ".cursor" / "rules")
        shutil.copy2(cursor_rule, dest / ".cursor" / "rules" / "har-workflow.mdc")
    return dest


def build_mcp_config(arm: str, repo_path: Path, run_dir: Path) -> Path | None:
    if arm != "har":
        empty = {"mcpServers": {}}
        path = run_dir / "mcp-empty.json"
        path.write_text(json.dumps(empty, indent=2) + "\n", encoding="utf-8")
        return path
    config = {
        "mcpServers": {
            "har": {
                "command": "har",
                "args": ["mcp", "--repo", str(repo_path)],
            }
        }
    }
    path = run_dir / "mcp-har.json"
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return path


def telemetry_env(base_env: dict[str, str], run_id: str, arm: str, repo: dict, issue: dict) -> dict[str, str]:
    env = dict(base_env)
    env["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1"
    env["OTEL_TRACES_EXPORTER"] = "otlp"
    env["CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"] = "1"
    env["CLAUDE_CODE_OTEL_DIAG_STDERR"] = "1"
    host = base_env.get("LANGFUSE_HOST", benchmark_config().get("langfuse_host", "http://localhost:3300"))
    if base_env.get("LANGFUSE_PUBLIC_KEY") and base_env.get("LANGFUSE_SECRET_KEY"):
        env["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf"
        env["OTEL_EXPORTER_OTLP_ENDPOINT"] = f"{host.rstrip('/')}/api/public/otel"
        env["OTEL_EXPORTER_OTLP_HEADERS"] = langfuse_auth_header(
            base_env["LANGFUSE_PUBLIC_KEY"], base_env["LANGFUSE_SECRET_KEY"]
        )
    env["HAR_BENCHMARK_RUN_ID"] = run_id
    env["HAR_BENCHMARK_ARM"] = arm
    env["HAR_BENCHMARK_REPO"] = f"{repo['owner']}/{repo['name']}"
    env["HAR_BENCHMARK_ISSUE"] = str(issue["issue_number"])
    return env


def count_patterns(text: str, patterns: list[str]) -> int:
    total = 0
    lowered = text.lower()
    for pattern in patterns:
        total += len(re.findall(pattern, lowered))
    return total


def collect_local_metrics(repo_path: Path, stdout: str, stderr: str, started: float, exit_code: int) -> dict:
    combined = f"{stdout}\n{stderr}"
    diff = run_command(["git", "diff", "--stat"], cwd=repo_path)
    return {
        "wall_clock_seconds": round(time.time() - started, 2),
        "exit_code": exit_code,
        "verify_attempts": count_patterns(combined, [r"verify", r"npm test", r"pnpm test", r"yarn test", r"playwright"]),
        "failed_verify_attempts": count_patterns(combined, [r"fail", r"error", r"exit code [1-9]"]),
        "tool_calls": count_patterns(combined, [r"tool_use", r"tool call", r"bash\(", r"edit\("]),
        "agent_turns": count_patterns(combined, [r'"type": "assistant"', r"assistant:"]),
        "git_diff_stat": diff.stdout.strip(),
        "changed_files": len([line for line in run_command(["git", "diff", "--name-only"], cwd=repo_path).stdout.splitlines() if line.strip()]),
    }


def external_verify(repo_path: Path, arm: str) -> dict:
    if arm == "har" and (repo_path / ".har").exists():
        result = run_command(["har", "env", "launch", "1", "--force"], cwd=repo_path)
        if result.returncode != 0:
            return {"verified": False, "details": "launch failed", "stdout": result.stdout, "stderr": result.stderr}
        verify = run_command(["har", "env", "verify", "1", "--full"], cwd=repo_path)
        return {
            "verified": verify.returncode == 0,
            "details": "har env verify 1 --full",
            "stdout": verify.stdout[-6000:],
            "stderr": verify.stderr[-6000:],
        }

    for cmd in (
        ["npm", "test", "--", "--runInBand", "--passWithNoTests"],
        ["pnpm", "test"],
        ["yarn", "test"],
    ):
        if shutil.which(cmd[0]):
            result = run_command(cmd, cwd=repo_path)
            if result.returncode == 0:
                return {"verified": True, "details": " ".join(cmd), "stdout": result.stdout[-4000:], "stderr": result.stderr[-4000:]}
    return {"verified": False, "details": "no default verification command succeeded", "stdout": "", "stderr": ""}


def run_attempt(arm: str, issue: dict, repo: dict, dry_run: bool, timeout_minutes: int) -> dict:
    run_id = str(uuid.uuid4())
    run_dir = workspace_dir(arm, repo, issue)
    repo_path = run_dir / "repo"
    prompt = render_template(
        FIX_PROMPT,
        {
            "owner": repo["owner"],
            "name": repo["name"],
            "issue_url": issue["issue_url"],
            "base_commit": issue["base_commit"],
        },
    )
    mcp_config = build_mcp_config(arm, repo_path, run_dir)
    record = {
        "run_id": run_id,
        "arm": arm,
        "repo": issue["repo"],
        "issue_number": issue["issue_number"],
        "issue_url": issue["issue_url"],
        "base_commit": issue["base_commit"],
        "started_at": now_iso(),
        "prompt": prompt,
        "run_dir": str(run_dir),
        "repo_path": str(repo_path),
        "dry_run": dry_run,
    }
    if dry_run:
        record["status"] = "dry-run"
        write_json(run_dir / "run.json", record)
        return record

    prepare_repo(repo, issue, arm, repo_path)

    env = telemetry_env(load_benchmark_env(), run_id, arm, repo, issue)
    started = time.time()
    cmd = [
        "claude",
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        "--strict-mcp-config",
        "--mcp-config",
        str(mcp_config),
        "--output-format",
        "json",
    ]
    result = run_command(cmd, cwd=repo_path, env=env, timeout=timeout_minutes * 60)
    record["claude"] = {
        "exit_code": result.returncode,
        "stdout": result.stdout[-12000:],
        "stderr": result.stderr[-12000:],
    }
    record["metrics"] = collect_local_metrics(repo_path, result.stdout, result.stderr, started, result.returncode)
    record["external_verification"] = external_verify(repo_path, arm)
    record["finished_at"] = now_iso()
    record["status"] = "completed"
    write_json(run_dir / "run.json", record)
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arm", choices=["raw", "har"], required=True)
    parser.add_argument("--repo", required=True, help="Repo id or owner/name")
    parser.add_argument("--issue-number", type=int)
    parser.add_argument("--issue-id")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--timeout-minutes", type=int, default=benchmark_config().get("time_budget_minutes", 90))
    args = parser.parse_args()

    repo = repo_meta(args.repo)
    issue = issue_meta(args.issue_id, f"{repo['owner']}/{repo['name']}", args.issue_number)
    record = run_attempt(args.arm, issue, repo, args.dry_run, args.timeout_minutes)
    print(json.dumps({"run_id": record["run_id"], "run_dir": record["run_dir"], "status": record["status"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
