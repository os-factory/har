#!/usr/bin/env python3
"""Run one paired instance under protocol v2, then score both arms.

Both arms receive a byte-identical, minimal prompt: repository, commit, and the dataset's
problem statement. Nothing tells either arm to install, launch, test or verify. The only
difference between the arms is what the checkout contains.

ARM A (HAR)
  clone @ base_commit into an opaque work dir
  → cache hit? apply cached harness → `har env maintain` drift report
    cache miss? `har env init` → task-blind adaptation sessions (setup_model)
  → runner readiness gate: doctor → launch → verify → verify --full
    (records what launch dirties, then TEARS THE SLOT DOWN)
  → commit the harness ("chore: development environment setup")
  → solve session in the main checkout: an un-launched, HAR-enabled repository
  → patch from the slot worktree, the session branch, or the main checkout
  → optional informational `verify --full`, then teardown

ARM B (raw)
  clone @ base_commit into an opaque work dir → solve session → patch

ARM B' (ablation, --prompt-variant verify)
  ARM B plus the v1 environment/verification instructions, to separate "HAR" from
  "told the model to verify".
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.behaviors import classify  # noqa: E402
from lib.claude_runner import run_claude_with_retry  # noqa: E402
from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    acquire_runner_lock,
    PROMPTS_DIR,
    append_jsonl,
    benchmark_config,
    clone_repo_at_commit,
    commit_date,
    ensure_dir,
    log_event,
    new_run_id,
    now_iso,
    render_template,
    run_command,
    free_gb,
    run_work_dir,
    sha256_text,
    tool_versions,
    work_id,
    write_json,
)
from lib.datasets import agent_view, find_instance  # noqa: E402
from lib.har_cache import (  # noqa: E402
    apply_cache,
    cache_exists,
    cache_meta,
    changed_paths,
    commit_harness,
    save_cache,
    split_paths,
)
from lib.har_utils import (  # noqa: E402
    copy_har_artifacts,
    format_gate_failure,
    gate,
    infer_profile,
    infra_down,
    init_scaffold,
    maintain_report,
    read_adapt_prompt,
    read_profile,
    slot_branch,
    slot_workdir,
    teardown,
    verify,
)
from lib.patch import build_model_patch, commit_range_diff, extract_model_patch  # noqa: E402
from lib.scoring import score_instance  # noqa: E402

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
PROTOCOL = "v2"


# --------------------------------------------------------------------------- prompt


def download_assets(instance: dict[str, Any], assets_dir: Path) -> tuple[list[str], list[str]]:
    ensure_dir(assets_dir)
    saved: list[str] = []
    failed: list[str] = []
    for i, url in enumerate(instance.get("image_urls") or []):
        suffix = Path(url.split("?")[0]).suffix.lower()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
                if suffix not in IMAGE_EXTS:
                    guessed = mimetypes.guess_extension(resp.headers.get_content_type() or "") or ""
                    suffix = guessed if guessed in IMAGE_EXTS else suffix
            if suffix not in IMAGE_EXTS:
                failed.append(url)
                continue
            target = assets_dir / f"image-{i + 1:02d}{suffix}"
            target.write_bytes(data)
            saved.append(str(target))
        except Exception:
            failed.append(url)
    return saved, failed


def assets_note(saved: list[str], failed: list[str], assets_dir: Path) -> str:
    if not saved and not failed:
        return ""
    lines = [f"- `{p}`" for p in saved]
    if failed:
        lines.append("")
        lines.append("Could not be downloaded (original URLs):")
        lines += [f"- {u}" for u in failed]
    return render_template(PROMPTS_DIR / "assets-note.md", {"assets_dir": str(assets_dir), "assets_list": "\n".join(lines)})


def task_prompt(instance: dict[str, Any], *, assets: str, variant: str) -> str:
    """The prompt. Identical for every arm; `variant=verify` adds the ablation note only."""
    ablation = (PROMPTS_DIR / "ablation-verify.md").read_text(encoding="utf-8") if variant == "verify" else ""
    return render_template(
        PROMPTS_DIR / "task.md",
        {
            "repo": instance["repo"],
            "base_commit": instance["base_commit"],
            "problem_statement": instance["problem_statement"].strip(),
            "assets_note": assets,
            "ablation_note": ablation,
        },
    )


# --------------------------------------------------------------------------- helpers


def compact_gate(g: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"ready": g.get("ready"), "failed_stage": g.get("failed_stage"), "full_ok": g.get("full_ok")}
    for key in ("doctor", "launch", "verify_quick", "verify_full"):
        v = g.get(key)
        if v is None:
            out[key] = None
            continue
        out[key] = {"ok": v.get("ok"), "exit_code": v.get("exit_code")}
        if key.startswith("verify") and isinstance(v.get("json"), dict):
            steps = v["json"].get("steps") or v["json"].get("stages") or []
            out[key]["steps"] = [
                {"id": s.get("name") or s.get("id"), "ok": s.get("pass", s.get("ok")), "ms": s.get("ms") or s.get("durationMs")}
                for s in steps
                if isinstance(s, dict)
            ][:40]
    return out


def _cost(session: dict[str, Any]) -> float:
    return float((session.get("result") or {}).get("total_cost_usd") or 0.0)


def _turns(session: dict[str, Any]) -> int | None:
    return (session.get("result") or {}).get("num_turns")


def _compact_session(session: dict[str, Any]) -> dict[str, Any]:
    keep = {k: v for k, v in session.items() if k not in {"bash_commands_sample"}}
    keep["bash_commands_sample"] = (session.get("bash_commands_sample") or [])[:80]
    return keep


def _session_failed(session: dict[str, Any]) -> str | None:
    """Reason the session did not really run (usage cap, auth, crash) — never scored."""
    if session.get("usage_limited"):
        return "claude usage limit not cleared after retries"
    r = session.get("result") or {}
    if r.get("is_error"):
        return f"claude session error: {(r.get('final_text') or '')[:200]}"
    if session.get("exit_code") not in (0, None) and not session.get("timed_out") and (session.get("tool_calls") or 0) == 0:
        return f"claude exited {session.get('exit_code')} with no tool calls: {(session.get('stderr_tail') or '')[-200:]}"
    return None


def agent_edited_paths(session: dict[str, Any], work_dir: Path) -> set[str]:
    behaviour = classify(Path(session.get("transcript_path", "")), work_dir=work_dir)
    return set(behaviour.get("files_edited") or [])


def solve_session(*, cwd: Path, prompt: str, cfg: dict[str, Any], log_dir: Path, assets_dir: Path | None, label: str = "solve") -> dict[str, Any]:
    return run_claude_with_retry(
        cwd=cwd,
        prompt=prompt,
        model=cfg["solve_model"],
        timeout_seconds=int(cfg["solve_timeout_minutes"]) * 60,
        log_dir=log_dir,
        add_dirs=[assets_dir] if assets_dir else None,
        label=label,
        max_retries=int(cfg.get("usage_limit_retries", 0)),
        wait_seconds=int(cfg.get("usage_limit_wait_minutes", 20)) * 60,
        on_wait=lambda attempt, wait: log_event("claude.usage_limit.wait", attempt=attempt, wait_seconds=wait, label=label),
    )


def kill_stray_processes(path: Path) -> None:
    """Stop dev servers an arm may have left running under its checkout."""
    run_command(["pkill", "-f", str(path)], timeout=30)


# --------------------------------------------------------------------------- ARM A harness phase


def ensure_harness(instance: dict[str, Any], harness_root: Path, run_dir: Path, cfg: dict[str, Any]) -> dict[str, Any]:
    """Make the repository agent-ready with HAR, without ever seeing the task."""
    repo = instance["repo"]
    base = instance["base_commit"]
    setup_model = cfg["setup_model"]
    gate_timeout = int(cfg.get("gate_timeout_minutes", 45)) * 60
    log_dir = run_dir / "har" / "sessions"
    record: dict[str, Any] = {
        "cache_hit": False,
        "profile": None,
        "adapt_sessions": [],
        "drift_sessions": [],
        "gates": [],
        "ready": False,
        "started_at": now_iso(),
    }
    started = time.time()
    ensure_dir(run_dir / "har")

    clone_repo_at_commit(repo, base, harness_root)
    harness_commit: str | None = None
    g: dict[str, Any] = {"ready": False, "failed_stage": "not-run"}

    def adapt_round(prompt_path: Path, values: dict[str, Any], *, label: str, timeout_minutes: int, model: str) -> dict[str, Any]:
        prompt = render_template(prompt_path, values)
        session = run_claude_with_retry(
            cwd=harness_root,
            prompt=prompt,
            model=model,
            timeout_seconds=timeout_minutes * 60,
            log_dir=log_dir,
            label=label,
            max_retries=int(cfg.get("usage_limit_retries", 0)),
            wait_seconds=int(cfg.get("usage_limit_wait_minutes", 20)) * 60,
            on_wait=lambda attempt, wait: log_event("claude.usage_limit.wait", attempt=attempt, wait_seconds=wait, label=label),
        )
        return session

    if cache_exists(repo):
        meta = cache_meta(repo) or {}
        record["cache_hit"] = True
        record["cache_from_commit"] = meta.get("base_commit")
        record["cache_from_instance"] = meta.get("instance_id")
        applied = apply_cache(repo, harness_root)
        record["cache_files_applied"] = len(applied)
        record["profile"] = read_profile(harness_root) or meta.get("profile")
        log_event("har.cache.apply", instance=instance["instance_id"], repo=repo, files=len(applied), from_commit=meta.get("base_commit"))

        drift = maintain_report(harness_root)
        (run_dir / "har" / "drift-report.txt").write_text(drift["stdout"] + "\n" + drift["stderr"], encoding="utf-8")
        record["drift_report_exit_code"] = drift["exit_code"]

        harness_commit = commit_harness(harness_root)
        g = gate(harness_root, timeout_seconds=gate_timeout)
        record["gates"].append({"phase": "cache", "round": 0, **compact_gate(g)})
        record["gate_on_cache_ready"] = bool(g["ready"])
        log_event("har.gate", instance=instance["instance_id"], phase="cache", ready=g["ready"], failed_stage=g.get("failed_stage"))

        rounds = 0
        while not g["ready"] and rounds < int(cfg.get("drift_max_rounds", 2)):
            rounds += 1
            failure_text = format_gate_failure(g)
            (run_dir / "har" / f"gate-failure-drift-r{rounds}.md").write_text(failure_text, encoding="utf-8")
            session = adapt_round(
                PROMPTS_DIR / "har-drift.md",
                {
                    "repo": repo,
                    "base_commit": base,
                    "harness_root": str(harness_root),
                    "timeout_minutes": cfg.get("drift_timeout_minutes", 25),
                    "previous_commit": meta.get("base_commit"),
                    "drift_report": (drift["stdout"] + "\n" + drift["stderr"])[-8000:],
                    "failure_context": failure_text,
                },
                label=f"drift-r{rounds}",
                timeout_minutes=int(cfg.get("drift_timeout_minutes", 25)),
                model=setup_model,
            )
            record["drift_sessions"].append(_compact_session(session))
            log_event("har.drift.session", instance=instance["instance_id"], round=rounds, cost=_cost(session), turns=_turns(session), timed_out=session["timed_out"])
            teardown(harness_root)
            harness_commit = commit_harness(harness_root)
            g = gate(harness_root, timeout_seconds=gate_timeout)
            record["gates"].append({"phase": "drift", "round": rounds, **compact_gate(g)})
            log_event("har.gate", instance=instance["instance_id"], phase="drift", round=rounds, ready=g["ready"], failed_stage=g.get("failed_stage"))
        record["drift_rounds"] = rounds
    else:
        profile = infer_profile(harness_root, repo)
        record["profile_inferred"] = profile
        init = init_scaffold(harness_root, profile)
        record["init"] = {"ok": init["ok"], "profile": profile}
        log_event("har.init", instance=instance["instance_id"], repo=repo, profile=profile, ok=init["ok"])
        if not init["ok"]:
            record["error"] = "har env init failed: " + init["stderr"][-1000:]
            record["seconds"] = round(time.time() - started, 2)
            return record

        failure_text = ""
        rounds = 0
        budget = int(cfg.get("adapt_budget_minutes", 100)) * 60
        while not g["ready"] and rounds < int(cfg.get("adapt_max_rounds", 3)) and (time.time() - started) < budget:
            rounds += 1
            remaining_minutes = max(5, int((budget - (time.time() - started)) / 60))
            session = adapt_round(
                PROMPTS_DIR / "har-adapt.md",
                {
                    "repo": repo,
                    "base_commit": base,
                    "harness_root": str(harness_root),
                    "har_profile": read_profile(harness_root) or profile,
                    "timeout_minutes": min(int(cfg.get("adapt_timeout_minutes", 40)), remaining_minutes),
                    "har_adapt_prompt": read_adapt_prompt(harness_root),
                    "failure_context": failure_text,
                },
                label=f"adapt-r{rounds}",
                timeout_minutes=min(int(cfg.get("adapt_timeout_minutes", 40)), remaining_minutes),
                model=setup_model,
            )
            record["adapt_sessions"].append(_compact_session(session))
            log_event("har.adapt.session", instance=instance["instance_id"], round=rounds, cost=_cost(session), turns=_turns(session), timed_out=session["timed_out"])
            teardown(harness_root)
            harness_commit = commit_harness(harness_root)
            g = gate(harness_root, timeout_seconds=gate_timeout)
            record["gates"].append({"phase": "adapt", "round": rounds, **compact_gate(g)})
            log_event("har.gate", instance=instance["instance_id"], phase="adapt", round=rounds, ready=g["ready"], failed_stage=g.get("failed_stage"))
            if not g["ready"]:
                failure_text = format_gate_failure(g)
                (run_dir / "har" / f"gate-failure-adapt-r{rounds}.md").write_text(failure_text, encoding="utf-8")
        record["adapt_rounds"] = rounds
        record["profile"] = read_profile(harness_root) or profile

    record["full_verify_ok"] = bool(g.get("full_ok"))
    if not g["ready"]:
        # Rounds exhausted: fall back to a soft gate (doctor + launch + quick verify). Dropping
        # the repository instead would bias ARM A towards repositories that are easy to harness.
        g = gate(harness_root, timeout_seconds=gate_timeout, require_full=False)
        g["soft"] = True
        record["gates"].append({"phase": "soft", "round": 0, **compact_gate(g)})
        record["soft_gate_used"] = True
        record["full_verify_ok"] = bool(g.get("full_ok"))
        log_event("har.gate", instance=instance["instance_id"], phase="soft", ready=g["ready"], full_ok=g.get("full_ok"), failed_stage=g.get("failed_stage"))

    harness_commit = commit_harness(harness_root)
    owned, foreign = split_paths(changed_paths(harness_root, base))
    record.update(
        {
            "harness_files": len(owned),
            "harness_touched_product_files": foreign,
            "ready": bool(g["ready"]),
            "harness_commit": harness_commit,
            "launch_side_effects": g.get("side_effect_files") or {},
            "last_gate_failed_stage": g.get("failed_stage"),
            "seconds": round(time.time() - started, 2),
            "cost_usd": round(sum(_cost(s) for s in record["adapt_sessions"] + record["drift_sessions"]), 4),
            "finished_at": now_iso(),
        }
    )

    if record["harness_files"]:
        save_cache(
            repo,
            harness_root,
            base,
            instance_id=instance["instance_id"],
            profile=record["profile"],
            event={
                "protocol": PROTOCOL,
                "cache_hit": record["cache_hit"],
                "adapt_rounds": record.get("adapt_rounds", 0),
                "drift_rounds": record.get("drift_rounds", 0),
                "gate_on_cache_ready": record.get("gate_on_cache_ready"),
                "ready": record["ready"],
                "full_verify_ok": record["full_verify_ok"],
                "soft_gate_used": record.get("soft_gate_used", False),
                "cost_usd": record["cost_usd"],
                "seconds": record["seconds"],
                "har_version": tool_versions().get("har"),
            },
        )
        log_event("har.cache.save", instance=instance["instance_id"], repo=repo, files=record["harness_files"], foreign=len(foreign), ready=record["ready"], full_ok=record["full_verify_ok"])
    return record


# --------------------------------------------------------------------------- arms


def har_patch_source(harness_root: Path, harness_commit: str) -> tuple[str, Path, str]:
    """Where the agent's work ended up: its slot worktree, a session branch, or the checkout."""
    workdir = slot_workdir(harness_root)
    if workdir and workdir.exists():
        return "slot_worktree", workdir, "working_tree"
    branch = slot_branch(harness_root)
    if branch:
        ahead = run_command(["git", "-C", str(harness_root), "rev-list", "--count", f"{harness_commit}..{branch}"])
        if ahead.returncode == 0 and (ahead.stdout.strip() or "0") != "0":
            return "session_branch", harness_root, branch
    return "main_checkout", harness_root, "working_tree"


def run_har_arm(instance: dict[str, Any], run_dir: Path, work_dir: Path, cfg: dict[str, Any], *, assets: str, assets_dir: Path | None, variant: str) -> dict[str, Any]:
    harness_root = work_dir / "a" / "repo"
    record: dict[str, Any] = {"arm": "har", "protocol": PROTOCOL, "model": cfg["solve_model"], "harness_root": str(harness_root), "started_at": now_iso()}
    harness = ensure_harness(instance, harness_root, run_dir, cfg)
    record["harness"] = harness
    if not harness.get("ready") or not harness.get("harness_commit"):
        record["status"] = "failed"
        record["error"] = f"HAR readiness gate failed (stage {harness.get('last_gate_failed_stage')}) — solve not run"
        record["finished_at"] = now_iso()
        copy_har_artifacts(harness_root, run_dir / "har" / "artifacts")
        teardown(harness_root)
        log_event("arm.har.failed", instance=instance["instance_id"], reason=record["error"])
        return record

    prompt = task_prompt(instance, assets=assets, variant=variant)
    record["prompt_sha256"] = sha256_text(prompt)
    log_event("arm.har.solve.start", instance=instance["instance_id"], cwd=str(harness_root))
    session = solve_session(cwd=harness_root, prompt=prompt, cfg=cfg, log_dir=run_dir / "har" / "sessions", assets_dir=assets_dir)
    record["solve"] = _compact_session(session)
    failed = _session_failed(session)

    source, patch_dir, ref = har_patch_source(harness_root, harness["harness_commit"])
    record["patch_source"] = source
    record["patch_dir"] = str(patch_dir)
    behaviour = classify(Path(session.get("transcript_path", "")), work_dir=patch_dir)
    record["behaviour"] = behaviour
    log_event(
        "arm.har.solve.done",
        instance=instance["instance_id"],
        cost=_cost(session),
        turns=_turns(session),
        timed_out=session["timed_out"],
        har_launch=behaviour["har_launch"],
        har_verify=behaviour["har_verify"],
        patch_source=source,
    )

    if failed:
        record["status"] = "session_error"
        record["error"] = failed
        record["finished_at"] = now_iso()
        teardown(harness_root)
        log_event("arm.har.session_error", instance=instance["instance_id"], reason=failed)
        return record

    # Patch first: an informational verify afterwards must not add its side effects to it.
    if ref == "working_tree":
        patch = extract_model_patch(
            patch_dir,
            harness["harness_commit"],
            hidden_test_patch=instance["hidden"].get("test_patch"),
            launch_side_effects=harness.get("launch_side_effects"),
            agent_edited=set(behaviour["files_edited"]),
        )
    else:
        patch = build_model_patch(
            commit_range_diff(harness_root, harness["harness_commit"], ref),
            hidden_test_patch=instance["hidden"].get("test_patch"),
            launch_side_effects=harness.get("launch_side_effects"),
            agent_edited=set(behaviour["files_edited"]),
        )
        patch["stash_recovered"] = False
        patch["raw_diff"] = commit_range_diff(harness_root, harness["harness_commit"], ref)
    ensure_dir(run_dir / "predictions")
    (run_dir / "predictions" / "har.patch").write_text(patch["patch"], encoding="utf-8")
    (run_dir / "predictions" / "har.raw.patch").write_text(patch.get("raw_diff") or "", encoding="utf-8")
    record["patch"] = {k: v for k, v in patch.items() if k not in {"patch", "raw_diff"}} | {"bytes": len(patch["patch"])}

    if source == "slot_worktree":
        post = verify(harness_root, full=True, timeout=int(cfg.get("gate_timeout_minutes", 45)) * 60)
        record["post_verify_full"] = {"ok": post["ok"], "exit_code": post["exit_code"]}
        (run_dir / "har" / "post-verify-full.txt").write_text(post["stdout"] + "\n" + post["stderr"], encoding="utf-8")
    else:
        record["post_verify_full"] = {"skipped": "no slot was launched by the agent"}

    copy_har_artifacts(harness_root, run_dir / "har" / "artifacts")
    # Keep the session branch: once the worktree is removed it is the only copy of work the
    # agent committed, and re-filtering a patch later must not need the agent to run again.
    record["teardown"] = teardown(harness_root, delete_branch=False)["ok"]
    kill_stray_processes(harness_root)
    record["status"] = "completed"
    record["finished_at"] = now_iso()
    return record


def run_raw_arm(instance: dict[str, Any], run_dir: Path, work_dir: Path, cfg: dict[str, Any], *, assets: str, assets_dir: Path | None, variant: str) -> dict[str, Any]:
    arm = "raw_verify" if variant == "verify" else "raw"
    repo_dir = work_dir / ("b_prime" if variant == "verify" else "b") / "repo"
    record: dict[str, Any] = {"arm": arm, "protocol": PROTOCOL, "model": cfg["solve_model"], "repo_dir": str(repo_dir), "started_at": now_iso()}
    clone_repo_at_commit(instance["repo"], instance["base_commit"], repo_dir)
    prompt = task_prompt(instance, assets=assets, variant=variant)
    record["prompt_sha256"] = sha256_text(prompt)
    log_event(f"arm.{arm}.solve.start", instance=instance["instance_id"], cwd=str(repo_dir))
    session = solve_session(cwd=repo_dir, prompt=prompt, cfg=cfg, log_dir=run_dir / arm / "sessions", assets_dir=assets_dir)
    record["solve"] = _compact_session(session)
    behaviour = classify(Path(session.get("transcript_path", "")), work_dir=repo_dir)
    record["behaviour"] = behaviour
    log_event(
        f"arm.{arm}.solve.done",
        instance=instance["instance_id"],
        cost=_cost(session),
        turns=_turns(session),
        timed_out=session["timed_out"],
        started_services=behaviour["started_services"],
        ran_tests=behaviour["ran_tests"],
    )
    failed = _session_failed(session)
    if failed:
        record["status"] = "session_error"
        record["error"] = failed
        record["finished_at"] = now_iso()
        log_event(f"arm.{arm}.session_error", instance=instance["instance_id"], reason=failed)
        return record

    patch = extract_model_patch(
        repo_dir,
        instance["base_commit"],
        hidden_test_patch=instance["hidden"].get("test_patch"),
        agent_edited=set(behaviour["files_edited"]),
    )
    ensure_dir(run_dir / "predictions")
    (run_dir / "predictions" / f"{arm}.patch").write_text(patch["patch"], encoding="utf-8")
    (run_dir / "predictions" / f"{arm}.raw.patch").write_text(patch.get("raw_diff") or "", encoding="utf-8")
    record["patch"] = {k: v for k, v in patch.items() if k not in {"patch", "raw_diff"}} | {"bytes": len(patch["patch"])}
    kill_stray_processes(repo_dir)
    record["status"] = "completed"
    record["finished_at"] = now_iso()
    return record


# --------------------------------------------------------------------------- scoring + rows


def score_arm(instance: dict[str, Any], run_dir: Path, arm: str, cfg: dict[str, Any], run_id: str) -> dict[str, Any]:
    patch_path = run_dir / "predictions" / f"{arm}.patch"
    patch_text = patch_path.read_text(encoding="utf-8") if patch_path.exists() else ""
    log_event("score.start", instance=instance["instance_id"], arm=arm, patch_bytes=len(patch_text))
    result = score_instance(instance, patch_text, run_dir / "score" / arm, model_name=f"{cfg['solve_model']}-{arm}", run_id=f"{run_id}-{arm}")
    log_event("score.done", instance=instance["instance_id"], arm=arm, resolved=result.get("resolved"), error=result.get("error"))
    return result


def score_gold(instance: dict[str, Any], run_dir: Path, cfg: dict[str, Any], run_id: str) -> dict[str, Any]:
    log_event("score.gold.start", instance=instance["instance_id"])
    result = score_instance(instance, instance["hidden"].get("patch") or "", run_dir / "score" / "gold", model_name="gold", run_id=f"{run_id}-gold")
    log_event("score.gold.done", instance=instance["instance_id"], resolved=result.get("resolved"), error=result.get("error"))
    return result


def result_row(instance: dict[str, Any], run_record: dict[str, Any], arm: str) -> dict[str, Any]:
    arm_rec = run_record["arms"].get(arm) or {}
    solve = arm_rec.get("solve") or {}
    res = solve.get("result") or {}
    behaviour = arm_rec.get("behaviour") or {}
    score = (run_record.get("scores") or {}).get(arm) or {}
    row = {
        "protocol": arm_rec.get("protocol", PROTOCOL),
        "run_id": run_record["run_id"],
        "dataset": instance["dataset"],
        "instance_id": instance["instance_id"],
        "repo": instance["repo"],
        "base_commit": instance["base_commit"],
        "base_commit_ts": run_record.get("base_commit_ts"),
        "arm": arm,
        "model": arm_rec.get("model"),
        "status": arm_rec.get("status"),
        "prompt_sha256": arm_rec.get("prompt_sha256"),
        "resolved": bool(score.get("resolved")) if score else None,
        "score_error": score.get("error"),
        "score_skipped": score.get("skipped"),
        "patch_empty": (arm_rec.get("patch") or {}).get("empty"),
        "patch_files": len((arm_rec.get("patch") or {}).get("files") or []),
        "cost_usd": res.get("total_cost_usd"),
        "num_turns": res.get("num_turns"),
        "tool_calls": solve.get("tool_calls"),
        "wall_clock_seconds": solve.get("wall_clock_seconds"),
        "timed_out": solve.get("timed_out"),
        "usage_limit_retries": solve.get("usage_limit_retries", 0),
        # measured behaviour (protocol v2: nothing in the prompt asks for any of this)
        "provisioned_environment": behaviour.get("provisioned_environment"),
        "installed_deps": behaviour.get("installed_deps"),
        "started_services": behaviour.get("started_services"),
        "ran_tests": behaviour.get("ran_tests"),
        "ran_build_or_lint": behaviour.get("ran_build_or_lint"),
        "verified_anything": behaviour.get("verified_anything"),
        "committed": behaviour.get("committed"),
        "test_files_edited": len(behaviour.get("test_files_edited") or []),
        "test_paths_excluded": len((arm_rec.get("patch") or {}).get("test_paths_excluded") or []),
        "har_any": behaviour.get("har_any"),
        "har_launch": behaviour.get("har_launch"),
        "har_verify": behaviour.get("har_verify"),
        "har_verify_full": behaviour.get("har_verify_full"),
        "read_harness_docs": behaviour.get("read_harness_docs"),
        "finished_at": arm_rec.get("finished_at"),
    }
    if arm == "har":
        h = arm_rec.get("harness") or {}
        row.update(
            {
                "har_profile": h.get("profile"),
                "har_cache_hit": h.get("cache_hit"),
                "har_gate_on_cache_ready": h.get("gate_on_cache_ready"),
                "har_adapt_rounds": h.get("adapt_rounds", 0),
                "har_drift_rounds": h.get("drift_rounds", 0),
                "har_setup_cost_usd": h.get("cost_usd"),
                "har_setup_seconds": h.get("seconds"),
                "har_ready": h.get("ready"),
                "har_full_verify_ok": h.get("full_verify_ok"),
                "har_soft_gate_used": h.get("soft_gate_used", False),
                "har_touched_product_files": len(h.get("harness_touched_product_files") or []),
                "patch_source": arm_rec.get("patch_source"),
                "har_post_verify_full_ok": (arm_rec.get("post_verify_full") or {}).get("ok"),
            }
        )
    return row


ARM_RUNNERS = {"har": run_har_arm, "raw": run_raw_arm}


def run_one(
    dataset: str,
    instance_id: str,
    *,
    arms: list[str],
    skip_score: bool,
    gold: bool,
    dry_run: bool,
    infra_down_after: bool,
    variant: str = "minimal",
) -> dict[str, Any]:
    cfg = benchmark_config()
    instance = find_instance(dataset, instance_id)
    run_id = new_run_id(instance_id)
    run_dir = ensure_dir(BENCHMARK_ROOT / cfg.get("runs_dir", "runs") / run_id)
    work_dir = ensure_dir(run_work_dir(run_id))
    write_json(run_dir / "instance.json", agent_view(instance))
    record: dict[str, Any] = {
        "protocol": PROTOCOL,
        "run_id": run_id,
        "work_dir": str(work_dir),
        "work_id": work_id(run_id),
        "dataset": dataset,
        "instance_id": instance_id,
        "repo": instance["repo"],
        "base_commit": instance["base_commit"],
        "base_commit_ts": commit_date(instance["repo"], instance["base_commit"]),
        "solve_model": cfg["solve_model"],
        "setup_model": cfg["setup_model"],
        "prompt_variant": variant,
        "solve_timeout_minutes": cfg["solve_timeout_minutes"],
        "tool_versions": tool_versions(),
        "prompt_templates_sha256": {p.name: sha256_text(p.read_text(encoding="utf-8")) for p in sorted(PROMPTS_DIR.glob("*.md"))},
        "started_at": now_iso(),
        "dry_run": dry_run,
        "arms": {},
        "scores": {},
    }
    log_event("instance.start", run_id=run_id, dataset=dataset, instance=instance_id, repo=instance["repo"], arms=",".join(arms), protocol=PROTOCOL)
    if dry_run:
        record["prompt_preview"] = task_prompt(instance, assets="", variant=variant)
        record["finished_at"] = now_iso()
        write_json(run_dir / "run.json", record)
        return record

    assets_dir: Path | None = None
    assets = ""
    if instance.get("image_urls"):
        assets_dir = work_dir / "assets"
        saved, failed = download_assets(instance, assets_dir)
        record["assets"] = {"saved": saved, "failed": failed}
        assets = assets_note(saved, failed, assets_dir)

    if gold and not skip_score:
        record["scores"]["gold"] = score_gold(instance, run_dir, cfg, run_id)
        write_json(run_dir / "run.json", record)

    for arm in arms:
        runner = ARM_RUNNERS["har" if arm == "har" else "raw"]
        arm_variant = "verify" if arm == "raw_verify" else variant
        rec = runner(instance, run_dir, work_dir, cfg, assets=assets, assets_dir=assets_dir, variant=arm_variant)
        record["arms"][rec["arm"]] = rec
        write_json(run_dir / "run.json", record)

    # One prompt for every arm is the core fairness claim: assert it, per run.
    hashes = {a: r.get("prompt_sha256") for a, r in record["arms"].items() if r.get("prompt_sha256") and a != "raw_verify"}
    record["prompt_identical_across_arms"] = len(set(hashes.values())) <= 1
    if not record["prompt_identical_across_arms"]:
        log_event("prompt.mismatch", instance=instance_id, hashes=hashes)

    if not skip_score:
        for arm, rec in record["arms"].items():
            if rec.get("status") == "completed":
                record["scores"][arm] = score_arm(instance, run_dir, arm, cfg, run_id)
            else:
                record["scores"][arm] = {"resolved": False, "error": rec.get("error", "arm did not complete"), "skipped": True}
            write_json(run_dir / "run.json", record)

    if infra_down_after and "har" in record["arms"]:
        record["infra_down"] = infra_down(work_dir / "a" / "repo")

    record["finished_at"] = now_iso()
    write_json(run_dir / "run.json", record)
    results_path = BENCHMARK_ROOT / cfg.get("results_dir", "results") / "results.jsonl"
    for arm in record["arms"]:
        append_jsonl(results_path, result_row(instance, record, arm))
    if not cfg.get("keep_work_dirs", False) and not skip_score:
        # Everything needed later (raw diff, graded patch, transcripts, scores) lives under runs/.
        import shutil as _shutil

        size_mb = sum(f.stat().st_size for f in work_dir.rglob("*") if f.is_file()) // (1024 * 1024) if work_dir.exists() else 0
        _shutil.rmtree(work_dir, ignore_errors=True)
        record["work_dir_removed_mb"] = size_mb
        write_json(run_dir / "run.json", record)
        log_event("work.cleanup", run_id=run_id, freed_mb=size_mb, free_gb=round(free_gb(), 1))

    log_event("instance.done", run_id=run_id, instance=instance_id, scores={a: s.get("resolved") for a, s in record["scores"].items()})
    return record


def parse_arms(value: str) -> list[str]:
    if value == "both":
        return ["har", "raw"]
    if value == "all":
        return ["har", "raw", "raw_verify"]
    if value == "none":
        return []
    return [value]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--arm", choices=["har", "raw", "raw_verify", "both", "all", "none"], default="both")
    parser.add_argument("--prompt-variant", choices=["minimal", "verify"], default="minimal", help="'verify' adds the ablation instructions to every arm")
    parser.add_argument("--skip-score", action="store_true")
    parser.add_argument("--gold", action="store_true", help="also score the dataset's gold patch (scorer sanity check)")
    parser.add_argument("--dry-run", action="store_true", help="write the run record and the prompt preview, run no agents")
    parser.add_argument("--infra-down", action="store_true", help="stop the harness's shared Docker services afterwards")
    args = parser.parse_args()
    if not args.dry_run:
        acquire_runner_lock()
    record = run_one(
        args.dataset,
        args.instance_id,
        arms=parse_arms(args.arm),
        skip_score=args.skip_score,
        gold=args.gold,
        dry_run=args.dry_run,
        infra_down_after=args.infra_down,
        variant=args.prompt_variant,
    )
    print(json.dumps({"run_id": record["run_id"], "scores": {a: s.get("resolved") for a, s in record.get("scores", {}).items()}}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
