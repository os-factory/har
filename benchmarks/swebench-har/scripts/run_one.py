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
    har_runs_exist,
    har_teardown_slot,
    har_validate_ready,
    har_verify,
    read_har_adapt_prompt,
)
from lib.har_cache import (  # noqa: E402
    har_cache_exists,
    invalidate_har_cache,
    load_har_cache,
    save_har_cache,
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
    setup_model: str,
    env: dict[str, str],
    dry_run: bool,
    setup_timeout_minutes: int,
    readiness_timeout_minutes: int,
    solve_timeout_minutes: int,
    post_fix_verify_full: bool,
    setup_budget_minutes: int,
    setup_max_rounds: int,
) -> dict[str, Any]:
    cfg = benchmark_config()
    harness_root = run_dir / "har" / "repo"
    cache_dir = BENCHMARK_ROOT / cfg.get("repo_cache_dir", ".repo-cache")
    record: dict[str, Any] = {
        "arm": "har",
        "harness_root": str(harness_root),
        "setup_model": setup_model,
        "fix_model": model,
        "started_at": now_iso(),
    }

    if dry_run:
        record["status"] = "dry-run"
        record["finished_at"] = now_iso()
        return record

    clone_repo_at_commit(instance["repo"], instance["base_commit"], harness_root, cache_dir)
    profile = infer_har_profile(harness_root)
    record["har_profile"] = profile

    gate_timeout = max(setup_timeout_minutes, solve_timeout_minutes) * 60
    setup_budget_seconds = setup_budget_minutes * 60
    setup_started = time.time()
    task_overlay_dir = run_dir / "har" / "task-overlay"
    task_overlay_dir.mkdir(parents=True, exist_ok=True)

    cache_hit = False
    if har_cache_exists(instance["repo"], profile):
        cache_hit = load_har_cache(instance["repo"], harness_root)
        record["har_cache_hit"] = cache_hit

    need_bootstrap = not cache_hit
    bootstrap_attempts: list[dict[str, Any]] = []
    readiness_attempts: list[dict[str, Any]] = []
    gate_rounds: list[dict[str, Any]] = []
    cache_invalidated = False
    gate: dict[str, Any] = {"ready": False}
    failure_context = ""
    readiness_failure_context = ""

    for round_index in range(1, setup_max_rounds + 1):
        elapsed = time.time() - setup_started
        if elapsed >= setup_budget_seconds:
            record["har_setup_budget_exhausted"] = True
            break
        remaining_seconds = max(1, int(setup_budget_seconds - elapsed))

        if need_bootstrap:
            har_init_scaffold(harness_root, profile, env=env)
            bootstrap_prompt = render_template(
                PROMPTS / "har-setup.md",
                prompt_values(
                    instance,
                    har_profile=profile,
                    har_adapt_prompt=read_har_adapt_prompt(harness_root, profile),
                    setup_failure_context=failure_context,
                ),
            )
            bootstrap_codex = run_codex_turn(
                cwd=harness_root,
                prompt=bootstrap_prompt,
                model=setup_model,
                api_key=env.get("OPENAI_API_KEY"),
                timeout_seconds=min(setup_timeout_minutes * 60, remaining_seconds),
                artifacts_dir=run_dir / "har" / f"codex-bootstrap-r{round_index}",
            )
            bootstrap_attempts.append(
                {
                    "round": round_index,
                    "phase": "repo_bootstrap",
                    "codex": bootstrap_codex.result,
                    "wall_clock_seconds": bootstrap_codex.wall_clock_seconds,
                }
            )
            har_teardown_slot(harness_root, env=env)
            need_bootstrap = False

        readiness_prompt = render_template(
            PROMPTS / "har-task-readiness.md",
            prompt_values(
                instance,
                har_profile=profile,
                task_overlay_dir=str(task_overlay_dir),
                readiness_failure_context=readiness_failure_context,
            ),
        )
        readiness_codex = run_codex_turn(
            cwd=harness_root,
            prompt=readiness_prompt,
            model=model,
            api_key=env.get("OPENAI_API_KEY"),
            timeout_seconds=min(readiness_timeout_minutes * 60, remaining_seconds),
            artifacts_dir=run_dir / "har" / f"codex-readiness-r{round_index}",
        )
        readiness_attempts.append(
            {
                "round": round_index,
                "phase": "task_readiness",
                "codex": readiness_codex.result,
                "wall_clock_seconds": readiness_codex.wall_clock_seconds,
                "task_overlay_dir": str(task_overlay_dir),
                "task_overlay_files": _list_task_overlay_files(task_overlay_dir),
            }
        )
        har_teardown_slot(harness_root, env=env)

        gate = har_validate_ready(
            harness_root,
            timeout_seconds=gate_timeout,
            env=_merge_task_overlay_env(env, task_overlay_dir),
        )
        gate_rounds.append({"round": round_index, "gate": gate})
        record[f"har_gate_round_{round_index}"] = gate

        if gate["ready"]:
            save_har_cache(instance["repo"], harness_root, profile)
            record["har_cache_saved"] = True
            break

        if cache_hit or har_cache_exists(instance["repo"], profile):
            if invalidate_har_cache(instance["repo"]):
                cache_invalidated = True
        cache_hit = False
        need_bootstrap = True
        failure_context = _format_gate_failure(gate, structured=True)
        readiness_failure_context = _format_readiness_failure(gate, round_index)

    record["har_setup_seconds"] = round(time.time() - setup_started, 2)
    record["har_setup_budget_minutes"] = setup_budget_minutes
    record["har_setup_budget_used_seconds"] = record["har_setup_seconds"]
    record["har_setup_rounds"] = len(gate_rounds)
    record["har_setup_max_rounds"] = setup_max_rounds
    record["har_cache_invalidated"] = cache_invalidated
    record["har_bootstrap_attempts"] = bootstrap_attempts
    record["har_task_readiness"] = {
        "attempts": readiness_attempts,
        "rounds": len(readiness_attempts),
        "skipped_bootstrap": bool(record.get("har_cache_hit")) and not bootstrap_attempts,
        "overlay_dir": str(task_overlay_dir),
        "overlay_files": _list_task_overlay_files(task_overlay_dir),
        "status": "passed" if gate.get("ready") else "failed",
    }
    if bootstrap_attempts:
        record["codex_bootstrap"] = bootstrap_attempts[-1]["codex"]
    elif record.get("har_cache_hit") and gate.get("ready"):
        record["codex_bootstrap"] = {"status": "skipped", "reason": "har_cache_valid"}
    if readiness_attempts:
        record["codex_readiness"] = readiness_attempts[-1]["codex"]
    record["har_setup_attempts"] = bootstrap_attempts
    if bootstrap_attempts:
        record["codex_setup"] = bootstrap_attempts[-1]["codex"]
    elif record.get("har_cache_hit") and gate.get("ready"):
        record["codex_setup"] = {"status": "skipped", "reason": "har_cache_valid"}
    record["har_gate_initial"] = gate_rounds[0]["gate"] if gate_rounds else gate

    if not gate["ready"] or not gate.get("workdir"):
        record["har_launch"] = {
            "ok": gate.get("launch_ok", False),
            "log": gate.get("launch_log", ""),
            "workdir": gate.get("workdir"),
        }
        record["har_verify"] = gate.get("verify")
        record["status"] = "failed"
        record["error"] = "HAR pre-fix gate failed (launch or smoke verify) before fix stage"
        record["finished_at"] = now_iso()
        return record

    workdir = Path(gate["workdir"])
    record["har_launch"] = {
        "ok": True,
        "log": gate.get("launch_log", ""),
        "workdir": str(workdir),
    }
    record["har_gate_launch"] = gate.get("launch")
    record["har_gate_smoke"] = gate.get("smoke")
    record["har_ready_for_fix"] = True

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

    verify_result = har_verify(harness_root, full=post_fix_verify_full, env=env)
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
    if not record.get("har_ready_for_fix"):
        invalid_reasons.append("launch_gate_failed")
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


def _list_task_overlay_files(task_overlay_dir: Path) -> list[str]:
    if not task_overlay_dir.exists():
        return []
    return sorted(
        str(path.relative_to(task_overlay_dir))
        for path in task_overlay_dir.rglob("*")
        if path.is_file()
    )


def _merge_task_overlay_env(env: dict[str, str], task_overlay_dir: Path) -> dict[str, str]:
    merged = dict(env)
    task_env = task_overlay_dir / "task.env"
    if not task_env.exists():
        return merged
    for line in task_env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        merged[key.strip()] = value.strip().strip('"').strip("'")
    return merged


def _format_readiness_failure(gate: dict[str, Any], round_index: int) -> str:
    return (
        f"\n## Previous task readiness round {round_index} failed the pre-fix gate\n"
        f"{_format_gate_failure(gate, structured=True)}\n"
    )


def _format_gate_failure(gate: dict[str, Any], *, structured: bool = False) -> str:
    launch = gate.get("launch") or {}
    smoke = gate.get("smoke") or {}
    verify = smoke.get("verify") or gate.get("verify") or {}

    if structured:
        payload = {
            "ready": gate.get("ready"),
            "launch_ok": launch.get("launch_ok", gate.get("launch_ok")),
            "workdir": launch.get("workdir", gate.get("workdir")),
            "agent_env_exists": launch.get("agent_env_exists", gate.get("agent_env_exists")),
            "smoke_ready": smoke.get("ready"),
            "verify_exit_code": verify.get("exit_code"),
            "verify_stderr_tail": (verify.get("stderr") or "")[-2000:],
            "launch_log_tail": (launch.get("launch_log", gate.get("launch_log", "")))[-2000:],
        }
        return (
            "\n## Previous pre-fix gate failed (structured)\n"
            "Fix harness.env and verify.sh quick-mode steps only — do not edit launch.sh.\n\n"
            f"```json\n{json.dumps(payload, indent=2)}\n```\n"
        )

    return (
        "\n## Previous pre-fix gate failed\n"
        "The benchmark runner could not launch the slot or pass quick smoke verify. "
        "Fix harness.env and verify.sh quick-mode steps only — do not edit launch.sh.\n\n"
        f"Launch ready: {launch.get('ready', gate.get('launch_ok'))}\n"
        f"Agent env exists: {launch.get('agent_env_exists', gate.get('agent_env_exists'))}\n"
        f"Smoke ready: {smoke.get('ready')}\n"
        f"Launch log (tail):\n```\n{launch.get('launch_log', gate.get('launch_log', ''))}\n```\n"
        f"Smoke verify exit code: {verify.get('exit_code')}\n"
        f"Smoke verify stderr (tail):\n```\n{verify.get('stderr', '')}\n```\n"
    )



def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, help="Random seed when sampling an instance")
    parser.add_argument("--instance-id", help="Pin a specific SWE-bench instance_id")
    parser.add_argument("--run-id", help="Reuse an existing run directory")
    parser.add_argument("--model", help="Codex model for raw/fix arms (default: gpt-5-mini)")
    parser.add_argument("--setup-model", help="Codex model for HAR setup (default: gpt-5.5)")
    parser.add_argument("--arm", choices=["raw", "har", "both"], default="both")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--solve-timeout-minutes", type=int, help="Override solve timeout")
    parser.add_argument("--setup-timeout-minutes", type=int, help="Override HAR setup timeout")
    args = parser.parse_args()

    cfg = benchmark_config()
    env = load_benchmark_env()
    model = args.model or env.get("OPENAI_MODEL") or cfg.get("model", "gpt-5-mini")
    setup_model = args.setup_model or env.get("OPENAI_SETUP_MODEL") or cfg.get("setup_model", "gpt-5.5")
    solve_timeout = args.solve_timeout_minutes or int(cfg.get("solve_timeout_minutes", 60))
    setup_timeout = args.setup_timeout_minutes or int(cfg.get("setup_timeout_minutes", 45))
    readiness_timeout = int(cfg.get("readiness_timeout_minutes", 20))
    setup_budget = int(cfg.get("setup_budget_minutes", 120))
    setup_max_rounds = int(cfg.get("setup_max_rounds", 6))

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
        "setup_model": setup_model,
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
            setup_model=setup_model,
            env=env,
            dry_run=args.dry_run,
            setup_timeout_minutes=setup_timeout,
            readiness_timeout_minutes=readiness_timeout,
            solve_timeout_minutes=solve_timeout,
            post_fix_verify_full=bool(cfg.get("har_verify_full", False)),
            setup_budget_minutes=setup_budget,
            setup_max_rounds=setup_max_rounds,
        )

    run_record["finished_at"] = now_iso()
    write_json(run_dir / "run.json", run_record)
    print(json.dumps({"run_id": instance["run_id"], "run_dir": str(run_dir)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
