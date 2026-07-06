#!/usr/bin/env python3
"""Evaluate a benchmark run and post scores to Langfuse."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    benchmark_issues,
    langfuse_request,
    load_benchmark_env,
    patch_overlap,
    read_json,
    write_json,
)


def has_frontend_test_changes(run: dict) -> bool:
    changed = run.get("metrics", {}).get("changed_file_list") or []
    keywords = ("playwright", "e2e", "spec.", "cypress", "frontend", "web", "ui", "component", ".test.")
    return any(any(keyword in name.lower() for keyword in keywords) for name in changed)


def quality_label(oracle_pass: float, overlap: float, e2e: float) -> str:
    if oracle_pass >= 1.0:
        return "good"
    if overlap > 0 or e2e >= 1.0:
        return "partial"
    return "bad"


def post_score(host: str, public_key: str, secret_key: str, trace_id: str, name: str, value: float | str, data_type: str, comment: str = "") -> None:
    payload = {
        "traceId": trace_id,
        "name": name,
        "value": value,
        "dataType": data_type,
        "comment": comment,
    }
    langfuse_request(
        "POST",
        "/api/public/scores",
        host=host,
        public_key=public_key,
        secret_key=secret_key,
        payload=payload,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-json", type=Path, required=True)
    parser.add_argument("--trace-id", help="Langfuse trace id to attach scores to")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    run = read_json(args.run_json)
    issue = next(
        (
            item
            for item in benchmark_issues()
            if item["repo"] == run["repo"] and item["issue_number"] == run["issue_number"]
        ),
        None,
    )
    if issue is None:
        raise SystemExit("Matching issue not found in issues.yaml")

    ext = run.get("external_verification", {})
    oracle_pass = 1.0 if ext.get("oracle_pass") else 0.0
    verified = 1.0 if ext.get("verified") else 0.0
    e2e = 1.0 if has_frontend_test_changes(run) else 0.0
    changed = run.get("metrics", {}).get("changed_file_list") or []
    overlap = patch_overlap(changed, issue.get("reference_files") or [])
    metrics = run.get("metrics", {})
    success = oracle_pass
    success_comment = ext.get("oracle_details") or ("oracle passed" if oracle_pass else "oracle failed")

    scores = {
        "success": success,
        "oracle_pass": oracle_pass,
        "verified": verified,
        "patch_overlap": overlap,
        "e2e_added_or_updated": e2e,
        "wall_clock_seconds": metrics.get("wall_clock_seconds", 0),
        "tokens_total": metrics.get("tokens_total", 0),
        "tokens_input": metrics.get("tokens_input", 0),
        "tokens_output": metrics.get("tokens_output", 0),
        "cost_usd": metrics.get("cost_usd", 0),
        "agent_turns": metrics.get("agent_turns", 0),
        "tool_calls": metrics.get("tool_calls", 0),
        "verify_attempts": metrics.get("verify_attempts", 0),
        "failed_verify_attempts": metrics.get("failed_verify_attempts", 0),
        "harness_setup_seconds": run.get("harness_setup_seconds", 0),
        "quality": quality_label(oracle_pass, overlap, e2e),
    }
    evaluation = {
        "run_id": run["run_id"],
        "arm": run["arm"],
        "scores": scores,
        "success_comment": success_comment,
        "trace_id": args.trace_id,
    }
    eval_path = Path(run["run_dir"]) / "evaluation.json"
    write_json(eval_path, evaluation)

    if args.dry_run or not args.trace_id:
        print(f"Wrote {eval_path} (dry-run, no Langfuse scores posted)")
        return 0

    env = load_benchmark_env()
    host = env.get("LANGFUSE_HOST", "http://localhost:3300")
    public_key = env["LANGFUSE_PUBLIC_KEY"]
    secret_key = env["LANGFUSE_SECRET_KEY"]
    for name, value in scores.items():
        data_type = "CATEGORICAL" if name == "quality" else "NUMERIC"
        post_score(host, public_key, secret_key, args.trace_id, name, value, data_type, success_comment if name == "success" else "")
    print(f"Posted scores for trace {args.trace_id} -> {eval_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
