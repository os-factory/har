#!/usr/bin/env python3
"""Create Langfuse dataset items and score configs for the benchmark."""

from __future__ import annotations

import argparse
import sys
import uuid
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    benchmark_config,
    benchmark_issues,
    langfuse_request,
    load_benchmark_env,
    now_iso,
    write_json,
)

BENCHMARK_ROOT = Path(__file__).resolve().parents[1]


def ensure_dataset(host: str, public_key: str, secret_key: str, dataset_name: str) -> None:
    try:
        langfuse_request(
            "GET",
            f"/api/public/v2/datasets/{dataset_name}",
            host=host,
            public_key=public_key,
            secret_key=secret_key,
        )
        print(f"Dataset exists: {dataset_name}")
    except RuntimeError:
        langfuse_request(
            "POST",
            "/api/public/v2/datasets",
            host=host,
            public_key=public_key,
            secret_key=secret_key,
            payload={
                "name": dataset_name,
                "description": "HAR vs raw Claude Code frontend issue replay benchmark",
                "metadata": {"benchmark": "har-vs-raw", "created_at": now_iso()},
            },
        )
        print(f"Created dataset: {dataset_name}")


def upsert_dataset_item(
    host: str,
    public_key: str,
    secret_key: str,
    dataset_name: str,
    issue: dict,
) -> dict:
    item_id = issue.get("id") or f"{issue['repo'].replace('/', '-')}-{issue['issue_number']}"
    payload = {
        "id": item_id,
        "datasetName": dataset_name,
        "input": {
            "repo": issue["repo"],
            "issue_url": issue["issue_url"],
            "issue_number": issue["issue_number"],
            "base_commit": issue["base_commit"],
            "title": issue.get("title"),
            "task_type": issue.get("task_type", "frontend_bugfix"),
            "allowed_scope": issue.get("allowed_scope", []),
            "acceptance_criteria": issue.get("acceptance_criteria", []),
            "time_budget_minutes": issue.get("time_budget_minutes", 90),
        },
        "expectedOutput": {
            "reference_pr": issue.get("reference_pr"),
            "evaluator_only": True,
        },
        "metadata": {
            "repo": issue["repo"],
            "issue_number": issue["issue_number"],
            "reference_pr": issue.get("reference_pr"),
            "merged_at": issue.get("merged_at"),
            "frontend_relevance": issue.get("frontend_relevance"),
            "difficulty": issue.get("difficulty"),
        },
    }
    try:
        langfuse_request(
            "GET",
            f"/api/public/v2/datasets/{dataset_name}/items/{item_id}",
            host=host,
            public_key=public_key,
            secret_key=secret_key,
        )
        langfuse_request(
            "PATCH",
            f"/api/public/v2/datasets/{dataset_name}/items/{item_id}",
            host=host,
            public_key=public_key,
            secret_key=secret_key,
            payload=payload,
        )
        action = "updated"
    except RuntimeError:
        langfuse_request(
            "POST",
            f"/api/public/v2/datasets/{dataset_name}/items",
            host=host,
            public_key=public_key,
            secret_key=secret_key,
            payload=payload,
        )
        action = "created"
    return {"id": item_id, "action": action}


def ensure_score_configs(host: str, public_key: str, secret_key: str, configs: list[dict]) -> list[dict]:
    created: list[dict] = []
    for cfg in configs:
        payload = {
            "name": cfg["name"],
            "dataType": cfg["data_type"],
            "description": cfg.get("description", ""),
        }
        if cfg.get("categories"):
            payload["categories"] = [{"label": c, "value": float(i)} for i, c in enumerate(cfg["categories"])]
        try:
            result = langfuse_request(
                "POST",
                "/api/public/score-configs",
                host=host,
                public_key=public_key,
                secret_key=secret_key,
                payload=payload,
            )
            created.append(result)
            print(f"Score config: {cfg['name']}")
        except RuntimeError as exc:
            print(f"Score config {cfg['name']} skipped: {exc}")
    return created


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config = benchmark_config()
    issues = benchmark_issues()
    if not issues:
        raise SystemExit("No issues found. Run scripts/select_issues.py first.")

    dataset_name = config["dataset_name"]
    manifest = {
        "dataset_name": dataset_name,
        "items": [],
        "score_configs": config.get("score_configs", []),
        "dry_run": args.dry_run,
    }

    if args.dry_run:
        for issue in issues:
            manifest["items"].append({"id": issue.get("id"), "issue_url": issue["issue_url"], "action": "dry-run"})
        write_json(BENCHMARK_ROOT / "results" / "dataset-manifest.json", manifest)
        print(f"Dry run: would upsert {len(issues)} dataset items into {dataset_name}")
        return 0

    env = load_benchmark_env()
    host = env.get("LANGFUSE_HOST", config.get("langfuse_host", "http://localhost:3300"))
    public_key = env.get("LANGFUSE_PUBLIC_KEY")
    secret_key = env.get("LANGFUSE_SECRET_KEY")
    if not public_key or not secret_key:
        raise SystemExit("Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in benchmarks/har-vs-raw/.env.local")

    ensure_dataset(host, public_key, secret_key, dataset_name)
    ensure_score_configs(host, public_key, secret_key, config.get("score_configs", []))
    for issue in issues:
        manifest["items"].append(
            upsert_dataset_item(host, public_key, secret_key, dataset_name, issue)
        )
    write_json(BENCHMARK_ROOT / "results" / "dataset-manifest.json", manifest)
    print(f"Upserted {len(issues)} dataset items")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
