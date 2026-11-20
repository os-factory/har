"""Load both datasets into one normalized instance schema.

Agent-visible fields: dataset, kind, instance_id, repo, base_commit, problem_statement,
created_at, image_urls, extra. Evaluator-only fields live under `hidden` and are never
written into a run directory the agent can browse.
"""

from __future__ import annotations

import ast
import json
from typing import Any

from .common import BENCHMARK_ROOT, benchmark_config, commit_date

HIDDEN_KEY = "hidden"


def _parse_listish(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (list, dict)):
        return value
    text = str(value).strip()
    if not text:
        return []
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return ast.literal_eval(text)


def _load_prototypebench(key: str, spec: dict[str, Any]) -> list[dict[str, Any]]:
    path = BENCHMARK_ROOT / spec["instances_file"]
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    out = []
    for row in rows:
        f2p = _parse_listish(row.get("fail_to_pass")) or {}
        p2p = _parse_listish(row.get("pass_to_pass")) or {}
        env = _parse_listish(row.get("environment")) or {}
        out.append(
            {
                "dataset": key,
                "kind": "prototypebench",
                "instance_id": row["instance_id"],
                "repo": row["repo"],
                "base_commit": row["base_commit"],
                "problem_statement": row["problem_statement"],
                "created_at": row.get("created_at"),
                "image_urls": [],
                "extra": {
                    "stack_domain": row.get("stack_domain"),
                    "pr_number": row.get("pr_number"),
                    "pr_url": row.get("pr_url"),
                    "contamination_tier": row.get("contamination_tier"),
                    "environment": env,
                },
                HIDDEN_KEY: {
                    "patch": row.get("patch"),
                    "test_patch": row.get("test_patch"),
                    "test_patch_backend": row.get("test_patch_backend"),
                    "test_patch_frontend": row.get("test_patch_frontend"),
                    "fail_to_pass": f2p,
                    "pass_to_pass": p2p,
                    "head_commit": row.get("head_commit"),
                    "pr_title": row.get("pr_title"),
                    "notes": row.get("notes"),
                },
            }
        )
    return out


def _load_swebench(key: str, spec: dict[str, Any]) -> list[dict[str, Any]]:
    cache = BENCHMARK_ROOT / benchmark_config().get("vendor_dir", ".vendor") / f"{key}.json"
    if cache.exists():
        rows = json.loads(cache.read_text(encoding="utf-8"))
    else:
        from datasets import load_dataset  # heavy import, keep local

        ds = load_dataset(spec["hf_name"], split=spec["split"])
        rows = [dict(r) for r in ds]
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(rows), encoding="utf-8")
    out = []
    for row in rows:
        assets = _parse_listish(row.get("image_assets")) or {}
        urls = list(assets.get("problem_statement") or []) if isinstance(assets, dict) else []
        out.append(
            {
                "dataset": key,
                "kind": "swebench",
                "instance_id": row["instance_id"],
                "repo": row["repo"],
                "base_commit": row["base_commit"],
                "problem_statement": row["problem_statement"],
                "created_at": row.get("created_at"),
                "image_urls": urls,
                "extra": {
                    "version": row.get("version"),
                    "eval_image": row.get("image"),
                    "hf_name": spec["hf_name"],
                    "split": spec["split"],
                },
                HIDDEN_KEY: {
                    "patch": row.get("patch"),
                    "test_patch": row.get("test_patch"),
                    "fail_to_pass": _parse_listish(row.get("FAIL_TO_PASS")),
                    "pass_to_pass": _parse_listish(row.get("PASS_TO_PASS")),
                    "hints_text": row.get("hints_text"),
                    "image_assets": assets,
                },
            }
        )
    return out


def load_instances(dataset_key: str) -> list[dict[str, Any]]:
    cfg = benchmark_config()
    spec = cfg["datasets"][dataset_key]
    if spec["kind"] == "prototypebench":
        return _load_prototypebench(dataset_key, spec)
    if spec["kind"] == "swebench":
        return _load_swebench(dataset_key, spec)
    raise ValueError(f"unknown dataset kind {spec['kind']}")


def find_instance(dataset_key: str, instance_id: str) -> dict[str, Any]:
    for inst in load_instances(dataset_key):
        if inst["instance_id"] == instance_id:
            return inst
    raise KeyError(f"{instance_id} not in {dataset_key}")


def agent_view(instance: dict[str, Any]) -> dict[str, Any]:
    """Instance metadata safe to write where an agent might read it."""
    return {k: v for k, v in instance.items() if k != HIDDEN_KEY}


def order_by_commit_date(instances: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Oldest base_commit first (commit date from the bare clone; created_at as fallback)."""
    keyed = []
    for inst in instances:
        ts = commit_date(inst["repo"], inst["base_commit"])
        inst = dict(inst)
        inst["base_commit_ts"] = ts
        keyed.append(inst)
    keyed.sort(key=lambda i: (i["base_commit_ts"] is None, i["base_commit_ts"] or 0, i.get("created_at") or "", i["instance_id"]))
    return keyed


def group_by_repo(instances: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for inst in instances:
        groups.setdefault(inst["repo"], []).append(inst)
    return groups
