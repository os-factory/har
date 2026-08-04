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
    read_json,
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
    list_verification_stage_ids,
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
    fix_max_rounds: int = 3,
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

    # Repo-generic verification stages only — task-scoped stages must not enter .har-cache.
    baseline_verification_ids = set(list_verification_stage_ids(harness_root))
    record["har_baseline_verification_stages"] = sorted(baseline_verification_ids)

    need_bootstrap = not cache_hit
    bootstrap_attempts: list[dict[str, Any]] = []
    readiness_attempts: list[dict[str, Any]] = []
    gate_rounds: list[dict[str, Any]] = []
    cache_invalidated = False
    gate: dict[str, Any] = {"ready": False}
    oracle_ready = False
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
            # After bootstrap, treat current verificationStages as the new repo baseline.
            baseline_verification_ids = set(list_verification_stage_ids(harness_root))
            record["har_baseline_verification_stages"] = sorted(baseline_verification_ids)

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
            # Persist only repo-generic stages; keep task-scoped ones live for this run.
            task_stage_ids = sorted(
                set(list_verification_stage_ids(harness_root)) - baseline_verification_ids
            )
            record["har_task_verification_stages"] = task_stage_ids

            if not task_stage_ids:
                readiness_failure_context = (
                    f"\n## Previous readiness round {round_index}: missing task-scoped stage\n"
                    "You must register at least one **issue-specific** verification stage "
                    "(`har env add-stage <id> --custom … --verification`) that encodes the "
                    "bug from the problem statement.\n"
                    "Repo-generic compile/import/smoke stages alone are **not** enough.\n"
                    "The stage must be written to **fail on this buggy tree** (fail-before).\n"
                )
                har_teardown_slot(harness_root, env=env)
                continue

            # Fail-before gate: task stages must fail on the buggy tree for a behavioral reason.
            fail_before_verify = har_verify(
                harness_root,
                full=True,
                env=_merge_task_overlay_env(env, task_overlay_dir),
            )
            fb_ok, fb_reason, fb_detail = _assess_fail_before(
                fail_before_verify, task_stage_ids
            )
            record["har_fail_before"] = {
                "ok": fb_ok,
                "reason": fb_reason,
                "detail": fb_detail,
                "verified": fail_before_verify.get("verified"),
                "exit_code": fail_before_verify.get("exit_code"),
            }
            if not fb_ok:
                readiness_failure_context = _format_fail_before_failure(
                    round_index,
                    fb_reason,
                    fail_before_verify,
                    task_stage_ids,
                )
                har_teardown_slot(harness_root, env=env)
                continue

            _snapshot_task_stages(harness_root, task_overlay_dir, task_stage_ids)
            save_har_cache(
                instance["repo"],
                harness_root,
                profile,
                keep_verification_stage_ids=baseline_verification_ids,
            )
            # Re-apply task stages after cache strip so fix/verify still see them.
            _restore_task_stages(harness_root, task_overlay_dir)
            record["har_cache_saved"] = True
            oracle_ready = True
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
        "status": "passed" if oracle_ready else "failed",
        "task_stages": record.get("har_task_verification_stages") or [],
        "fail_before": record.get("har_fail_before"),
    }
    if bootstrap_attempts:
        record["codex_bootstrap"] = bootstrap_attempts[-1]["codex"]
    elif record.get("har_cache_hit") and oracle_ready:
        record["codex_bootstrap"] = {"status": "skipped", "reason": "har_cache_valid"}
    if readiness_attempts:
        record["codex_readiness"] = readiness_attempts[-1]["codex"]
    record["har_setup_attempts"] = bootstrap_attempts
    if bootstrap_attempts:
        record["codex_setup"] = bootstrap_attempts[-1]["codex"]
    elif record.get("har_cache_hit") and oracle_ready:
        record["codex_setup"] = {"status": "skipped", "reason": "har_cache_valid"}
    record["har_gate_initial"] = gate_rounds[0]["gate"] if gate_rounds else gate

    if not oracle_ready or not gate.get("workdir"):
        record["har_ready_for_fix"] = False
        record["har_launch"] = {
            "ok": gate.get("launch_ok", False),
            "log": gate.get("launch_log", ""),
            "workdir": gate.get("workdir"),
        }
        record["har_verify"] = gate.get("verify")
        reasons: list[str] = []
        if not gate.get("ready"):
            reasons.append("launch_or_smoke_gate_failed")
        if not (record.get("har_task_verification_stages") or []):
            reasons.append("missing_task_stage")
        fb = record.get("har_fail_before") or {}
        if fb and not fb.get("ok"):
            reasons.append(f"fail_before:{fb.get('reason')}")
        if not reasons:
            reasons.append("oracle_gate_failed")
        record["har_invalid_reasons"] = reasons
        record["status"] = "failed"
        record["error"] = (
            "HAR pre-fix oracle gate failed "
            f"({', '.join(reasons)}) before fix stage"
        )
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
    fix_attempts: list[dict[str, Any]] = []
    verify_result: dict[str, Any] = {"verified": False, "full": post_fix_verify_full}
    fix_failure_context = ""

    for fix_round in range(1, max(1, fix_max_rounds) + 1):
        remaining_solve = max(
            60,
            solve_timeout_minutes * 60 - int(time.time() - solve_started),
        )
        fix_prompt = render_template(
            PROMPTS / "har-fix.md",
            prompt_values(
                instance,
                work_dir=str(workdir),
                fix_failure_context=fix_failure_context,
                fix_round=str(fix_round),
                fix_max_rounds=str(fix_max_rounds),
            ),
        )
        fix_codex = run_codex_turn(
            cwd=workdir,
            prompt=fix_prompt,
            model=model,
            api_key=env.get("OPENAI_API_KEY"),
            timeout_seconds=remaining_solve,
            artifacts_dir=run_dir / "har" / f"codex-fix-r{fix_round}",
        )
        verify_result = har_verify(
            harness_root,
            full=post_fix_verify_full,
            env=_merge_task_overlay_env(env, task_overlay_dir),
        )
        fix_attempts.append(
            {
                "round": fix_round,
                "codex": fix_codex.result,
                "wall_clock_seconds": fix_codex.wall_clock_seconds,
                "verify": {
                    "verified": verify_result.get("verified"),
                    "full": verify_result.get("full"),
                    "exit_code": verify_result.get("exit_code"),
                },
            }
        )
        if verify_result.get("verified"):
            break
        fix_failure_context = _format_post_fix_verify_failure(verify_result, fix_round)

    record["codex_fix"] = fix_attempts[-1]["codex"] if fix_attempts else {}
    record["har_fix_attempts"] = fix_attempts
    record["har_fix_rounds"] = len(fix_attempts)
    record["solve_seconds"] = round(time.time() - solve_started, 2)
    record["har_verify"] = verify_result
    record["har_verify_attempted"] = True
    record["har_verify_passed"] = bool(verify_result.get("verified"))
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
    if post_fix_verify_full and not record["har_verify_passed"]:
        invalid_reasons.append("post_fix_verify_failed")
    if not (record.get("har_task_verification_stages") or []):
        invalid_reasons.append("missing_task_stage")
    fb = record.get("har_fail_before") or {}
    if fb and not fb.get("ok"):
        invalid_reasons.append("fail_before_not_established")
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


def _snapshot_task_stages(
    harness_root: Path,
    task_overlay_dir: Path,
    task_stage_ids: list[str],
) -> None:
    """Copy task-scoped stage definitions/scripts into the per-run overlay."""
    if not task_stage_ids:
        return
    stages_path = harness_root / ".har" / "stages.json"
    if not stages_path.exists():
        return
    data = read_json(stages_path)
    stages = data.get("stages") or []
    if isinstance(stages, dict):
        entries = []
        for key, value in stages.items():
            if isinstance(value, dict):
                entry = dict(value)
                entry.setdefault("id", key)
                entries.append(entry)
    else:
        entries = [s for s in stages if isinstance(s, dict)]

    wanted = set(task_stage_ids)
    snap_entries: list[dict[str, Any]] = []
    overlay_stages = task_overlay_dir / "stages"
    overlay_stages.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        sid = str(entry.get("id") or "")
        if sid not in wanted:
            continue
        copied = dict(entry)
        script = copied.get("script")
        if isinstance(script, str) and script:
            src = harness_root / ".har" / script
            if src.exists():
                dest = overlay_stages / Path(script).name
                dest.write_bytes(src.read_bytes())
                copied["script"] = f"stages/{dest.name}"
        snap_entries.append(copied)
    write_json(
        task_overlay_dir / "task-stages.json",
        {"verificationStages": task_stage_ids, "stages": snap_entries},
    )


def _restore_task_stages(harness_root: Path, task_overlay_dir: Path) -> None:
    """Merge task-scoped stages from overlay back into the live harness."""
    snap_path = task_overlay_dir / "task-stages.json"
    if not snap_path.exists():
        return
    snap = read_json(snap_path)
    stages_path = harness_root / ".har" / "stages.json"
    if stages_path.exists():
        data = read_json(stages_path)
    else:
        data = {"verificationStages": [], "stages": []}

    existing_ids = {str(x) for x in (data.get("verificationStages") or [])}
    for sid in snap.get("verificationStages") or []:
        sid = str(sid)
        if sid not in existing_ids:
            data.setdefault("verificationStages", []).append(sid)
            existing_ids.add(sid)

    live_entries = data.get("stages") or []
    if isinstance(live_entries, dict):
        live_list = []
        for key, value in live_entries.items():
            if isinstance(value, dict):
                entry = dict(value)
                entry.setdefault("id", key)
                live_list.append(entry)
        live_entries = live_list
    live_by_id = {str(e.get("id") or ""): e for e in live_entries if isinstance(e, dict)}

    stages_dir = harness_root / ".har" / "stages"
    stages_dir.mkdir(parents=True, exist_ok=True)
    for entry in snap.get("stages") or []:
        if not isinstance(entry, dict):
            continue
        entry = dict(entry)
        sid = str(entry.get("id") or "")
        script = entry.get("script")
        if isinstance(script, str) and script:
            overlay_script = task_overlay_dir / script
            if not overlay_script.exists():
                overlay_script = task_overlay_dir / "stages" / Path(script).name
            if overlay_script.exists():
                dest = stages_dir / Path(script).name
                dest.write_bytes(overlay_script.read_bytes())
                entry["script"] = f"stages/{dest.name}"
        live_by_id[sid] = entry

    data["stages"] = list(live_by_id.values())
    write_json(stages_path, data)


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


def _format_post_fix_verify_failure(verify: dict[str, Any], fix_round: int) -> str:
    return (
        f"\n## Previous fix round {fix_round}: HAR verify --full failed\n"
        "HAR is a sandbox for verifying that your change works. Do not stop until "
        "`har env verify 1 --full` passes with a **behavioral** task stage.\n"
        "- Keep (or add) an issue-specific stage that encodes the bug from the problem "
        "statement — smoke/compile alone is not done.\n"
        "- Fail-before/pass-after: the stage must have failed on the buggy tree and "
        "must pass after your fix.\n"
        "- If the stage fails with ImportError/ModuleNotFoundError, fix the slot "
        "install/build so the oracle can run, then re-check behavior.\n"
        "- You may add `har env add-stage … --custom --verification` or a small "
        "focused regression script wired as that stage.\n\n"
        f"exit_code: {verify.get('exit_code')}\n"
        f"stderr (tail):\n```\n{(verify.get('stderr') or '')[-3000:]}\n```\n"
        f"stdout (tail):\n```\n{(verify.get('stdout') or '')[-2000:]}\n```\n"
    )


_ENV_FAILURE_MARKERS = (
    "ModuleNotFoundError",
    "ImportError",
    "No module named",
    "DLL load failed",
    "cannot import name",
    "error: Microsoft Visual C++",
    "pkg_resources.DistributionNotFound",
)


def _parse_verify_stages(verify: dict[str, Any]) -> list[dict[str, Any]]:
    stdout = verify.get("stdout") or ""
    if not stdout.strip():
        return []
    try:
        decoder = json.JSONDecoder()
        idx = stdout.find("{")
        if idx < 0:
            return []
        payload, _ = decoder.raw_decode(stdout[idx:])
        stages = payload.get("stages") or []
        return stages if isinstance(stages, list) else []
    except Exception:  # noqa: BLE001
        return []


def _assess_fail_before(
    verify: dict[str, Any],
    task_stage_ids: list[str],
) -> tuple[bool, str, dict[str, Any]]:
    """Return whether task stages fail on the buggy tree for a non-env reason."""
    stages = _parse_verify_stages(verify)
    by_name = {
        str(stage.get("name") or stage.get("id") or ""): stage
        for stage in stages
        if isinstance(stage, dict)
    }
    task_results = []
    for stage_id in task_stage_ids:
        stage = by_name.get(stage_id)
        if stage is None:
            continue
        output = str(stage.get("output") or "")
        passed = bool(stage.get("pass"))
        env_only = (not passed) and any(marker in output for marker in _ENV_FAILURE_MARKERS)
        task_results.append(
            {
                "id": stage_id,
                "pass": passed,
                "env_failure": env_only,
                "output_tail": output[-500:],
            }
        )

    detail = {"task_results": task_results, "all_stages": list(by_name.keys())}
    if not task_results:
        return False, "task_stages_not_executed", detail
    if all(item["pass"] for item in task_results):
        return False, "stages_pass_on_buggy_tree", detail
    if all(item["env_failure"] or item["pass"] for item in task_results) and any(
        item["env_failure"] for item in task_results
    ):
        return False, "env_blocks_oracle", detail
    # At least one behavioral failure among task stages.
    return True, "task_stage_failed_as_expected", detail


def _format_fail_before_failure(
    round_index: int,
    reason: str,
    verify: dict[str, Any],
    task_stage_ids: list[str],
) -> str:
    guidance = {
        "stages_pass_on_buggy_tree": (
            "Your task stage(s) already **pass** on the buggy tree — they do not prove "
            "the bug. Tighten the assertion so it fails before a correct fix "
            "(fail-before), using only the problem statement."
        ),
        "env_blocks_oracle": (
            "Your task stage failed only because the package/deps/extensions are not "
            "importable in the slot. Fix install/build in harness.env / quick verify "
            "so the behavioral check can run, then ensure it fails for the ticket reason."
        ),
        "task_stages_not_executed": (
            "Task stage ids were registered but did not appear in verify --full output. "
            "Ensure they are listed in verificationStages and the command/script path is valid."
        ),
    }.get(
        reason,
        "Establish a task-scoped behavioral stage that fails on this buggy tree "
        "for the problem-statement reason (fail-before).",
    )
    return (
        f"\n## Previous readiness round {round_index}: fail-before gate failed ({reason})\n"
        f"{guidance}\n"
        f"Task stage ids: {task_stage_ids}\n"
        f"verify exit_code: {verify.get('exit_code')}\n"
        f"stdout (tail):\n```\n{(verify.get('stdout') or '')[-2500:]}\n```\n"
        f"stderr (tail):\n```\n{(verify.get('stderr') or '')[-1500:]}\n```\n"
    )


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
            fix_max_rounds=int(cfg.get("fix_max_rounds", 3)),
        )

    run_record["finished_at"] = now_iso()
    write_json(run_dir / "run.json", run_record)
    print(json.dumps({"run_id": instance["run_id"], "run_dir": str(run_dir)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
