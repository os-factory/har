#!/usr/bin/env python3
"""Evaluate all predictions in a SWE-bench HAR batch with the official harness."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from evaluate_predictions import evaluate_one  # noqa: E402
from lib.common import BENCHMARK_ROOT, benchmark_config, ensure_dir, read_json, write_json  # noqa: E402

BASELINE = {
    "batch_id": "20260708-173731",
    "raw_patches": 10,
    "har_patches": 5,
    "count": 10,
    "seed": 42,
    "note": "orchestration only; official Docker eval was not run",
}


def latest_batch_dir() -> Path:
    batches_dir = BENCHMARK_ROOT / "batches"
    if not batches_dir.is_dir():
        raise SystemExit("No batches/ directory found")
    candidates = [path for path in batches_dir.iterdir() if path.is_dir() and (path / "batch.json").exists()]
    if not candidates:
        raise SystemExit("No batch.json found under batches/")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def resolve_batch_dir(batch_id: str | None, latest: bool) -> Path:
    if latest or not batch_id:
        return latest_batch_dir()
    path = BENCHMARK_ROOT / "batches" / batch_id
    if not (path / "batch.json").exists():
        raise SystemExit(f"Batch not found: {path}")
    return path


def prediction_has_patch(pred_path: Path) -> bool:
    if not pred_path.exists():
        return False
    try:
        line = pred_path.read_text(encoding="utf-8").strip().splitlines()[0]
        data = json.loads(line)
        return bool(str(data.get("model_patch", "")).strip())
    except (IndexError, json.JSONDecodeError, OSError):
        return False


def find_resolved(instance_id: str, eval_run_id: str, arm: str, eval_report: dict[str, Any]) -> bool | None:
    """Best-effort parse of official SWE-bench resolve outcome."""
    logs_root = BENCHMARK_ROOT / "logs" / "run_evaluation" / eval_run_id
    if logs_root.is_dir():
        for report_path in logs_root.rglob("report.json"):
            try:
                report = read_json(report_path)
            except (OSError, json.JSONDecodeError):
                continue
            entry = report.get(instance_id)
            if isinstance(entry, dict) and "resolved" in entry:
                return bool(entry["resolved"])

    # Official harness also writes <model>.<run_id>.json in cwd
    for path in BENCHMARK_ROOT.glob(f"*.{eval_run_id}.json"):
        try:
            data = read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        resolved_ids = data.get("resolved_ids") or []
        if instance_id in resolved_ids:
            return True
        unresolved_ids = data.get("unresolved_ids") or []
        if instance_id in unresolved_ids:
            return False
        if data.get("resolved_instances") == 1 and instance_id in (data.get("completed_ids") or []):
            return True

    # Fallback: scan evaluation JSON for resolved markers in stdout
    stdout = eval_report.get("stdout") or ""
    if f'"resolved": true' in stdout and instance_id in stdout:
        return True
    if f'"resolved": false' in stdout and instance_id in stdout:
        return False
    return None


def arm_row(run_dir: Path, instance_id: str, run_id: str, arm: str, *, max_workers: int, dry_run: bool) -> dict[str, Any]:
    run_json_path = run_dir / "run.json"
    run_json = read_json(run_json_path) if run_json_path.exists() else {}
    arm_meta = (run_json.get("arms") or {}).get(arm) or {}
    pred = run_dir / "predictions" / f"{arm}.jsonl"
    patch_produced = prediction_has_patch(pred)
    if not patch_produced and arm_meta.get("model_patch_empty") is False:
        patch_produced = True

    row: dict[str, Any] = {
        "arm": arm,
        "status": arm_meta.get("status"),
        "patch_produced": patch_produced,
        "har_ready_for_fix": arm_meta.get("har_ready_for_fix"),
        "model_patch_empty": arm_meta.get("model_patch_empty"),
        "error": arm_meta.get("error"),
    }

    if not patch_produced and not dry_run:
        row["evaluation"] = {"status": "skipped_no_patch"}
        row["resolved"] = None
        return row

    evaluation = evaluate_one(
        pred,
        instance_id,
        run_id,
        arm,
        max_workers=max_workers,
        dry_run=dry_run,
    )
    row["evaluation"] = {
        "status": evaluation.get("status"),
        "exit_code": evaluation.get("exit_code"),
        "eval_run_id": evaluation.get("eval_run_id"),
    }
    if dry_run:
        row["resolved"] = None
    else:
        row["resolved"] = find_resolved(instance_id, evaluation.get("eval_run_id", f"{run_id}-{arm}"), arm, evaluation)
    return row


def build_comparison(batch: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    count = int(batch.get("count") or len(rows))
    raw_patches = sum(1 for r in rows if (r.get("arms") or {}).get("raw", {}).get("patch_produced"))
    har_patches = sum(1 for r in rows if (r.get("arms") or {}).get("har", {}).get("patch_produced"))
    raw_resolved = sum(1 for r in rows if (r.get("arms") or {}).get("raw", {}).get("resolved") is True)
    har_resolved = sum(1 for r in rows if (r.get("arms") or {}).get("har", {}).get("resolved") is True)
    raw_evaled = sum(1 for r in rows if (r.get("arms") or {}).get("raw", {}).get("resolved") is not None)
    har_evaled = sum(1 for r in rows if (r.get("arms") or {}).get("har", {}).get("resolved") is not None)

    return {
        "batch_id": batch.get("batch_id"),
        "seed": batch.get("seed"),
        "count": count,
        "model": batch.get("model"),
        "setup_model": batch.get("setup_model"),
        "orchestration": {
            "raw_patches": raw_patches,
            "har_patches": har_patches,
            "raw_patch_rate": f"{raw_patches}/{count}",
            "har_patch_rate": f"{har_patches}/{count}",
        },
        "resolve": {
            "raw_resolved": raw_resolved,
            "har_resolved": har_resolved,
            "raw_resolve_rate": f"{raw_resolved}/{raw_evaled}" if raw_evaled else "n/a",
            "har_resolve_rate": f"{har_resolved}/{har_evaled}" if har_evaled else "n/a",
        },
        "baseline": BASELINE,
        "delta_vs_baseline": {
            "raw_patches": raw_patches - BASELINE["raw_patches"],
            "har_patches": har_patches - BASELINE["har_patches"],
        },
    }


def markdown_table(rows: list[dict[str, Any]]) -> str:
    lines = [
        "| # | Instance | Raw patch | Raw resolved | HAR patch | HAR ready | HAR resolved |",
        "|---|----------|-----------|--------------|-----------|-----------|--------------|",
    ]
    for index, row in enumerate(rows, start=1):
        arms = row.get("arms") or {}
        raw = arms.get("raw") or {}
        har = arms.get("har") or {}

        def fmt(val: Any) -> str:
            if val is True:
                return "yes"
            if val is False:
                return "no"
            return "—"

        lines.append(
            "| {idx} | `{iid}` | {rp} | {rr} | {hp} | {hrdy} | {hres} |".format(
                idx=index,
                iid=row.get("instance_id", ""),
                rp=fmt(raw.get("patch_produced")),
                rr=fmt(raw.get("resolved")),
                hp=fmt(har.get("patch_produced")),
                hrdy=fmt(har.get("har_ready_for_fix")),
                hres=fmt(har.get("resolved")),
            )
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-id", help="Batch id under batches/")
    parser.add_argument("--latest-batch", action="store_true", help="Use most recent batches/*/batch.json")
    parser.add_argument("--arm", choices=["raw", "har", "both"], default="both")
    parser.add_argument("--max-workers", type=int, default=1)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    batch_dir = resolve_batch_dir(args.batch_id, args.latest_batch)
    batch = read_json(batch_dir / "batch.json")
    cfg = benchmark_config()
    runs_dir = BENCHMARK_ROOT / cfg.get("runs_dir", "runs")
    results_dir = ensure_dir(BENCHMARK_ROOT / cfg.get("results_dir", "results") / f"batch-{batch['batch_id']}")

    arms = ["raw", "har"] if args.arm == "both" else [args.arm]
    rows: list[dict[str, Any]] = []

    print(f"Evaluating batch {batch['batch_id']} ({len(batch.get('instances') or [])} instances)", flush=True)
    for entry in batch.get("instances") or []:
        instance_id = entry.get("instance_id")
        run_id = entry.get("run_id")
        row: dict[str, Any] = {
            "instance_id": instance_id,
            "run_id": run_id,
            "batch_status": entry.get("status"),
            "arms": {},
        }
        if not run_id:
            row["error"] = entry.get("error") or "missing run_id"
            rows.append(row)
            continue

        run_dir = runs_dir / run_id
        if not run_dir.is_dir():
            row["error"] = f"run dir missing: {run_dir}"
            rows.append(row)
            continue

        print(f"  {instance_id} ({run_id}) ...", flush=True)
        for arm in arms:
            row["arms"][arm] = arm_row(
                run_dir,
                instance_id,
                run_id,
                arm,
                max_workers=args.max_workers,
                dry_run=args.dry_run,
            )
        rows.append(row)
        write_json(results_dir / "batch-evaluation.json", {"batch_id": batch["batch_id"], "instances": rows})

    comparison = build_comparison(batch, rows)
    report = {
        "batch_id": batch["batch_id"],
        "batch_dir": str(batch_dir),
        "dry_run": args.dry_run,
        "instances": rows,
        "comparison": comparison,
    }
    write_json(results_dir / "batch-evaluation.json", report)
    write_json(BENCHMARK_ROOT / cfg.get("results_dir", "results") / "ec2-comparison.json", comparison)
    table = markdown_table(rows)
    (results_dir / "batch-evaluation.md").write_text(
        f"# Batch {batch['batch_id']} evaluation\n\n"
        f"```json\n{json.dumps(comparison, indent=2)}\n```\n\n"
        f"{table}",
        encoding="utf-8",
    )
    print(table)
    print(json.dumps(comparison, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
