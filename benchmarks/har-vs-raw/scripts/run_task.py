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
    benchmark_config,
    campaign_config,
    campaign_issues,
    campaign_repos,
    changed_files_in_repo,
    ensure_dir,
    har_launch_slot,
    har_teardown_slot,
    har_verify_full,
    langfuse_auth_header,
    load_benchmark_env,
    now_iso,
    render_template,
    run_command,
    run_oracle,
    slugify,
    write_json,
)

FIX_PROMPT = BENCHMARK_ROOT / "prompts" / "fix-issue.md"
HAR_AGENT_ID = 1


def repo_meta(repo_slug: str, campaign: str = "default") -> dict:
    for repo in campaign_repos(campaign):
        if f"{repo['owner']}/{repo['name']}" == repo_slug or repo["id"] == repo_slug:
            return repo
    raise SystemExit(f"Unknown repo: {repo_slug}")


def issue_meta(issue_id: str | None, repo_slug: str, issue_number: int | None, campaign: str = "default") -> dict:
    issues = campaign_issues(campaign)
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

    if arm == "raw":
        for path in (dest / ".har", dest / ".cursor" / "rules" / "har-workflow.mdc"):
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()
        return dest

    harness_src = BENCHMARK_ROOT / "repos" / source_repo["id"] / ".har"
    if harness_src.exists():
        shutil.copytree(harness_src, dest / ".har")
    agent_md = BENCHMARK_ROOT / "repos" / source_repo["id"] / "AGENTS.md"
    if agent_md.exists():
        shutil.copy2(agent_md, dest / "AGENTS.md")
    cursor_rule = BENCHMARK_ROOT / "repos" / source_repo["id"] / ".cursor" / "rules" / "har-workflow.mdc"
    if cursor_rule.exists():
        ensure_dir(dest / ".cursor" / "rules")
        shutil.copy2(cursor_rule, dest / ".cursor" / "rules" / "har-workflow.mdc")
    return dest


def build_mcp_config(arm: str, harness_root: Path, run_dir: Path) -> Path:
    if arm != "har":
        path = run_dir / "mcp-empty.json"
        path.write_text(json.dumps({"mcpServers": {}}, indent=2) + "\n", encoding="utf-8")
        return path
    config = {
        "mcpServers": {
            "har": {
                "command": "har",
                "args": ["mcp", "--repo", str(harness_root)],
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


def collect_local_metrics(work_path: Path, stdout: str, stderr: str, started: float, exit_code: int) -> dict:
    combined = f"{stdout}\n{stderr}"
    diff = run_command(["git", "diff", "HEAD", "--stat"], cwd=work_path)
    changed = changed_files_in_repo(work_path)
    metrics = {
        "wall_clock_seconds": round(time.time() - started, 2),
        "exit_code": exit_code,
        "verify_attempts": count_patterns(combined, [r"verify", r"npm test", r"pnpm test", r"yarn test", r"playwright"]),
        "failed_verify_attempts": count_patterns(combined, [r"fail", r"error", r"exit code [1-9]"]),
        "tool_calls": count_patterns(combined, [r"tool_use", r"tool call", r"bash\(", r"edit\("]),
        "agent_turns": count_patterns(combined, [r'"type": "assistant"', r"assistant:", r'"num_turns"']),
        "git_diff_stat": diff.stdout.strip(),
        "changed_files": len(changed),
        "changed_file_list": changed,
        "tokens_total": 0,
        "tokens_input": 0,
        "tokens_output": 0,
        "cost_usd": 0,
    }
    try:
        for line in stdout.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            payload = json.loads(line)
            if payload.get("type") != "result":
                continue
            usage = payload.get("usage") or {}
            metrics["tokens_input"] = int(usage.get("input_tokens") or 0) + int(usage.get("cache_read_input_tokens") or 0)
            metrics["tokens_output"] = int(usage.get("output_tokens") or 0)
            metrics["tokens_total"] = metrics["tokens_input"] + metrics["tokens_output"]
            metrics["cost_usd"] = float(payload.get("total_cost_usd") or 0)
            metrics["agent_turns"] = int(payload.get("num_turns") or metrics["agent_turns"])
            break
    except Exception:
        pass
    return metrics


def external_verify(issue: dict, arm: str, harness_root: Path, work_path: Path) -> dict:
    oracle = run_oracle(issue, work_path)
    result = {
        "oracle_pass": oracle["passed"],
        "oracle_details": oracle["details"],
        "oracle_stdout": oracle.get("stdout", ""),
        "oracle_stderr": oracle.get("stderr", ""),
        "verified": False,
        "details": "",
        "stdout": "",
        "stderr": "",
    }
    if arm == "har" and (harness_root / ".har").exists():
        har_result = har_verify_full(harness_root, HAR_AGENT_ID)
        result["verified"] = har_result["verified"]
        result["details"] = har_result["details"]
        result["stdout"] = har_result.get("stdout", "")
        result["stderr"] = har_result.get("stderr", "")
    return result


def run_attempt(arm: str, issue: dict, repo: dict, dry_run: bool, timeout_minutes: int) -> dict:
    run_id = str(uuid.uuid4())
    run_dir = workspace_dir(arm, repo, issue)
    harness_root = run_dir / "repo"
    prompt = render_template(
        FIX_PROMPT,
        {
            "owner": repo["owner"],
            "name": repo["name"],
            "issue_url": issue["issue_url"],
            "base_commit": issue["base_commit"],
        },
    )
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
        "repo_path": str(harness_root),
        "dry_run": dry_run,
    }
    if dry_run:
        record["status"] = "dry-run"
        write_json(run_dir / "run.json", record)
        return record

    prepare_repo(repo, issue, arm, harness_root)
    work_path = harness_root
    slot_launched = False

    try:
        if arm == "har":
            ok, workdir, launch_log = har_launch_slot(harness_root, HAR_AGENT_ID)
            record["har_launch"] = {"ok": ok, "log": launch_log[-4000:]}
            if not ok or not workdir:
                record["status"] = "failed"
                record["error"] = f"HAR launch failed: {launch_log[-2000:]}"
                record["finished_at"] = now_iso()
                write_json(run_dir / "run.json", record)
                return record
            slot_launched = True
            work_path = workdir
            record["work_path"] = str(work_path)

        mcp_config = build_mcp_config(arm, harness_root, run_dir)
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
        result = run_command(cmd, cwd=work_path, env=env, timeout=timeout_minutes * 60)
        record["claude"] = {
            "exit_code": result.returncode,
            "stdout": result.stdout[-12000:],
            "stderr": result.stderr[-12000:],
        }
        record["metrics"] = collect_local_metrics(work_path, result.stdout, result.stderr, started, result.returncode)
        record["external_verification"] = external_verify(issue, arm, harness_root, work_path)
        record["finished_at"] = now_iso()
        record["status"] = "completed"
    finally:
        if slot_launched:
            har_teardown_slot(harness_root, HAR_AGENT_ID)

    write_json(run_dir / "run.json", record)
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arm", choices=["raw", "har"], required=True)
    parser.add_argument("--repo", required=True, help="Repo id or owner/name")
    parser.add_argument("--issue-number", type=int)
    parser.add_argument("--issue-id")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--campaign", choices=["default", "v3"], default="default")
    parser.add_argument("--timeout-minutes", type=int)
    args = parser.parse_args()
    cfg = campaign_config(args.campaign)
    timeout = args.timeout_minutes or cfg.get("time_budget_minutes", 45)

    repo = repo_meta(args.repo, args.campaign)
    issue = issue_meta(args.issue_id, f"{repo['owner']}/{repo['name']}", args.issue_number, args.campaign)
    record = run_attempt(args.arm, issue, repo, args.dry_run, timeout)
    print(json.dumps({"run_id": record["run_id"], "run_dir": record["run_dir"], "status": record["status"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
