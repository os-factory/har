#!/usr/bin/env python3
"""Run one paired SWE-bench Lite attempt: raw Codex vs HAR-assisted Codex."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.codex_runner import run_codex_turn  # noqa: E402
from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    benchmark_config,
    clone_repo_at_commit,
    ensure_dir,
    load_benchmark_env,
    new_run_id,
    now_iso,
    render_template,
    sanitize_instance_row,
    write_json,
    write_predictions,
)
from lib.har_utils import (  # noqa: E402
    copy_har_artifacts,
    har_init_scaffold,
    har_launch_slot,
    har_runs_exist,
    har_teardown_slot,
    har_verify,
)
from lib.patch import extract_model_patch, filter_changed_files
from lib.profile import infer_har_profile

PROMPTS = BENCHMARK_ROOT / "prompts"


def load_or_sample_instance(
    *,
    seed: int | None,
    instance_id: str | None,
    run_id: str | None,
) -> tuple[dict[str, Any], Path]:
    if run_id:
        run_dir = BENCHMARK_ROOT / benchmark_config().get("runs_dir", "runs") / run_id
        instance_path = run_dir / "instance.json"
        if not instance_path.exists():
            raise SystemExit(f"Missing instance.json for run_id={run_id}")
        return json.loads(instance_path.read_text(encoding="utf-8")), run_dir

    from lib.dataset import load_split, pick_row

    cfg = benchmark_config()
    rows = load_split(cfg["dataset_name"], cfg["split"])
    row = pick_row(rows, seed, instance_id)
    run_id = new_run_id(row["instance_id"])
    run_dir = ensure_dir(BENCHMARK_ROOT / cfg.get("runs_dir", "runs") / run_id)
    payload = {
        "run_id": run_id,
        "dataset_name": cfg["dataset_name"],
        "split": cfg["split"],
        "seed": seed,
        "instance_id": row["instance_id"],
        "repo": row["repo"],
        "base_commit": row["base_commit"],
        "problem_statement": row["problem_statement"],
        "version": row.get("version"),
        "agent_instance": sanitize_instance_row(row),
    }
    write_json(run_dir / "instance.json", payload)
    return payload, run_dir


def prompt_values(instance: dict[str, Any], **extra: Any) -> dict[str, Any]:
    values = {
        "repo": instance["repo"],
        "instance_id": instance["instance_id"],
        "base_commit": instance["base_commit"],
        "problem_statement": instance["problem_statement"],
    }
    values.update(extra)
    return values


def run_raw_arm(
    instance: dict[str, Any],
    run_dir: Path,
    *,
    model: str,
    env: dict[str, str],
    dry_run: bool,
    timeout_minutes: int,
) -> dict[str, Any]:
    cfg = benchmark_config()
    repo_dir = run_dir / "raw" / "repo"
    cache_dir = BENCHMARK_ROOT / cfg.get("repo_cache_dir", ".repo-cache")
    record: dict[str, Any] = {
        "arm": "raw",
        "repo_path": str(repo_dir),
        "started_at": now_iso(),
    }

    if dry_run:
        record["status"] = "dry-run"
        record["finished_at"] = now_iso()
        return record

    clone_repo_at_commit(instance["repo"], instance["base_commit"], repo_dir, cache_dir)
    prompt = render_template(PROMPTS / "raw-fix.md", prompt_values(instance))
    codex = run_codex_turn(
        cwd=repo_dir,
        prompt=prompt,
        model=model,
        api_key=env.get("OPENAI_API_KEY"),
        timeout_seconds=timeout_minutes * 60,
        artifacts_dir=run_dir / "raw" / "codex",
    )
    patch = extract_model_patch(repo_dir, instance["base_commit"])
    model_name = f"{model}-raw"
    pred_path = run_dir / "predictions" / "raw.jsonl"
    write_predictions(pred_path, instance["instance_id"], model_name, patch)

    record.update(
        {
            "codex": codex.result,
            "wall_clock_seconds": codex.wall_clock_seconds,
            "model_patch_empty": not bool(patch.strip()),
            "predictions_path": str(pred_path),
            "status": "completed",
            "finished_at": now_iso(),
        }
    )
    return record


def run_har_arm(
    instance: dict[str, Any],
    run_dir: Path,
    *,
    model: str,
    env: dict[str, str],
    dry_run: bool,
    setup_timeout_minutes: int,
    solve_timeout_minutes: int,
    verify_full: bool,
) -> dict[str, Any]:
    cfg = benchmark_config()
    harness_root = run_dir / "har" / "repo"
    cache_dir = BENCHMARK_ROOT / cfg.get("repo_cache_dir", ".repo-cache")
    record: dict[str, Any] = {
        "arm": "har",
        "harness_root": str(harness_root),
        "started_at": now_iso(),
    }

    if dry_run:
        record["status"] = "dry-run"
        record["finished_at"] = now_iso()
        return record

    clone_repo_at_commit(instance["repo"], instance["base_commit"], harness_root, cache_dir)
    profile = infer_har_profile(harness_root)
    record["har_profile"] = profile

    setup_started = time.time()
    har_init_scaffold(harness_root, profile, env=env)
    setup_prompt = render_template(
        PROMPTS / "har-setup.md",
        prompt_values(instance, har_profile=profile),
    )
    setup_codex = run_codex_turn(
        cwd=harness_root,
        prompt=setup_prompt,
        model=model,
        api_key=env.get("OPENAI_API_KEY"),
        timeout_seconds=setup_timeout_minutes * 60,
        artifacts_dir=run_dir / "har" / "codex-setup",
    )
    record["har_setup_seconds"] = round(time.time() - setup_started, 2)
    record["codex_setup"] = setup_codex.result

    launch_ok, workdir, launch_log = har_launch_slot(
        harness_root,
        timeout_seconds=max(setup_timeout_minutes, solve_timeout_minutes) * 60,
        env=env,
    )
    record["har_launch"] = {"ok": launch_ok, "log": launch_log[-4000:], "workdir": str(workdir) if workdir else None}
    if not launch_ok or not workdir:
        record["status"] = "failed"
        record["error"] = "HAR launch failed"
        record["finished_at"] = now_iso()
        return record

    solve_started = time.time()
    fix_prompt = render_template(
        PROMPTS / "har-fix.md",
        prompt_values(instance, work_dir=str(workdir)),
    )
    fix_codex = run_codex_turn(
        cwd=workdir,
        prompt=fix_prompt,
        model=model,
        api_key=env.get("OPENAI_API_KEY"),
        timeout_seconds=solve_timeout_minutes * 60,
        artifacts_dir=run_dir / "har" / "codex-fix",
    )
    record["codex_fix"] = fix_codex.result
    record["solve_seconds"] = round(time.time() - solve_started, 2)

    verify_result = har_verify(harness_root, full=verify_full, env=env)
    record["har_verify"] = verify_result
    record["har_verify_attempted"] = True
    record["har_verify_passed"] = verify_result["verified"]
    record["har_runs_recorded"] = har_runs_exist(harness_root)

    patch = extract_model_patch(workdir, instance["base_commit"])
    model_name = f"{model}-har"
    pred_path = run_dir / "predictions" / "har.jsonl"
    write_predictions(pred_path, instance["instance_id"], model_name, patch)

    copy_har_artifacts(harness_root, run_dir / "har" / "artifacts")

    har_teardown_slot(harness_root, env=env)

    invalid_reasons = []
    if not launch_ok:
        invalid_reasons.append("launch_failed")
    if not record["har_verify_attempted"]:
        invalid_reasons.append("no_verify_attempt")
    if not record["har_runs_recorded"]:
        invalid_reasons.append("no_har_run_records")

    record.update(
        {
            "wall_clock_seconds": round(record["har_setup_seconds"] + record["solve_seconds"], 2),
            "model_patch_empty": not bool(patch.strip()),
            "predictions_path": str(pred_path),
            "har_valid": not invalid_reasons,
            "har_invalid_reasons": invalid_reasons,
            "status": "completed" if not invalid_reasons else "completed_with_warnings",
            "finished_at": now_iso(),
        }
    )
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, help="Random seed when sampling an instance")
    parser.add_argument("--instance-id", help="Pin a specific SWE-bench instance_id")
    parser.add_argument("--run-id", help="Reuse an existing run directory")
    parser.add_argument("--model", help="Codex model override")
    parser.add_argument("--arm", choices=["raw", "har", "both"], default="both")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--solve-timeout-minutes", type=int, help="Override solve timeout")
    parser.add_argument("--setup-timeout-minutes", type=int, help="Override HAR setup timeout")
    args = parser.parse_args()

    cfg = benchmark_config()
    env = load_benchmark_env()
    model = args.model or env.get("OPENAI_MODEL") or cfg.get("model", "gpt-5-mini")
    solve_timeout = args.solve_timeout_minutes or int(cfg.get("solve_timeout_minutes", 60))
    setup_timeout = args.setup_timeout_minutes or int(cfg.get("setup_timeout_minutes", 45))

    instance, run_dir = load_or_sample_instance(
        seed=args.seed,
        instance_id=args.instance_id,
        run_id=args.run_id,
    )

    run_record: dict[str, Any] = {
        "run_id": instance["run_id"],
        "instance_id": instance["instance_id"],
        "repo": instance["repo"],
        "base_commit": instance["base_commit"],
        "model": model,
        "started_at": now_iso(),
        "dry_run": args.dry_run,
        "arms": {},
    }

    if args.arm in {"raw", "both"}:
        run_record["arms"]["raw"] = run_raw_arm(
            instance,
            run_dir,
            model=model,
            env=env,
            dry_run=args.dry_run,
            timeout_minutes=solve_timeout,
        )

    if args.arm in {"har", "both"}:
        run_record["arms"]["har"] = run_har_arm(
            instance,
            run_dir,
            model=model,
            env=env,
            dry_run=args.dry_run,
            setup_timeout_minutes=setup_timeout,
            solve_timeout_minutes=solve_timeout,
            verify_full=bool(cfg.get("har_verify_full", False)),
        )

    run_record["finished_at"] = now_iso()
    write_json(run_dir / "run.json", run_record)
    print(json.dumps({"run_id": instance["run_id"], "run_dir": str(run_dir)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
