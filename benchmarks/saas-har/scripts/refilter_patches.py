#!/usr/bin/env python3
"""Rebuild an existing run's graded patches from its on-disk checkouts, then re-score.

Use after a change to the patch-filtering rules: the checkouts under work_root and the session
branch in the ARM A harness root are enough to recompute a patch without re-running any agent.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.behaviors import classify  # noqa: E402
from lib.common import BENCHMARK_ROOT, acquire_runner_lock, append_jsonl, benchmark_config, log_event, read_json, write_json  # noqa: E402
from lib.datasets import find_instance  # noqa: E402
from lib.patch import build_model_patch, commit_range_diff, extract_model_patch  # noqa: E402
from run_instance import har_patch_source, result_row, score_arm  # noqa: E402


def rebuild(run_dir: Path, record: dict, instance: dict, arm: str) -> dict | None:
    arm_rec = record["arms"].get(arm)
    if not arm_rec or arm_rec.get("status") != "completed":
        return None
    behaviour = classify(Path((arm_rec.get("solve") or {}).get("transcript_path", "")))
    edited = set(behaviour.get("files_edited") or [])
    hidden = instance["hidden"].get("test_patch")
    saved_raw = run_dir / "predictions" / f"{arm}.raw.patch"
    saved_graded = run_dir / "predictions" / f"{arm}.patch"
    if arm == "har":
        harness_root = Path(arm_rec["harness_root"])
        harness_commit = arm_rec["harness"]["harness_commit"]
        side_effects = arm_rec["harness"].get("launch_side_effects") or {}
        if not harness_root.exists():
            source, patch_dir, ref = "gone", harness_root, "working_tree"
            patch = {"empty": True}
        else:
            source, patch_dir, ref = har_patch_source(harness_root, harness_commit)
        if not harness_root.exists():
            pass
        elif ref == "working_tree":
            patch = extract_model_patch(patch_dir, harness_commit, hidden_test_patch=hidden, launch_side_effects=side_effects, agent_edited=edited)
        else:
            patch = build_model_patch(
                commit_range_diff(harness_root, harness_commit, ref),
                hidden_test_patch=hidden,
                launch_side_effects=side_effects,
                agent_edited=edited,
            )
        if source != "gone":
            arm_rec["patch_source"] = source
    else:
        side_effects = {}
        repo_dir = Path(arm_rec["repo_dir"])
        patch = (
            extract_model_patch(repo_dir, instance["base_commit"], hidden_test_patch=hidden, agent_edited=edited)
            if repo_dir.exists()
            else {"empty": True}
        )
    if patch["empty"]:
        # The live source is gone (work dir cleaned up after scoring, or the worktree removed).
        # Re-filter a stored diff instead: the raw diff when we have it, else the graded patch.
        fallback = saved_raw if saved_raw.exists() and saved_raw.read_text(encoding="utf-8").strip() else saved_graded
        if fallback.exists() and fallback.read_text(encoding="utf-8").strip():
            patch = build_model_patch(
                fallback.read_text(encoding="utf-8"),
                hidden_test_patch=hidden,
                launch_side_effects=side_effects,
                agent_edited=edited,
            )
            arm_rec["patch_source"] = f"refiltered_from:{fallback.name}"
    if patch["empty"] and saved_graded.exists() and saved_graded.read_text(encoding="utf-8").strip():
        # Never destroy the only copy of an agent's work with an empty rebuild.
        log_event("patch.refilter.aborted", run_id=record["run_id"], arm=arm, reason="rebuild is empty but a non-empty patch exists")
        return None
    (run_dir / "predictions" / f"{arm}.patch").write_text(patch["patch"], encoding="utf-8")
    if patch.get("raw_diff"):
        (run_dir / "predictions" / f"{arm}.raw.patch").write_text(patch["raw_diff"], encoding="utf-8")
    arm_rec["patch_previous"] = arm_rec.get("patch")
    arm_rec["patch"] = {k: v for k, v in patch.items() if k not in {"patch", "raw_diff"}} | {"bytes": len(patch["patch"])}
    arm_rec["behaviour"] = behaviour
    return arm_rec["patch"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--arms", nargs="*", default=["har", "raw", "raw_verify"])
    parser.add_argument("--no-score", action="store_true")
    args = parser.parse_args()
    acquire_runner_lock()
    cfg = benchmark_config()
    run_dir = BENCHMARK_ROOT / cfg.get("runs_dir", "runs") / args.run_id
    record = read_json(run_dir / "run.json")
    instance = find_instance(record["dataset"], record["instance_id"])
    for arm in args.arms:
        rebuilt = rebuild(run_dir, record, instance, arm)
        if rebuilt is None:
            continue
        log_event("patch.refilter", run_id=args.run_id, arm=arm, files=rebuilt["files"], dropped=rebuilt["dropped_files"], tests_excluded=rebuilt.get("test_paths_excluded"))
        write_json(run_dir / "run.json", record)
        if not args.no_score:
            record.setdefault("scores", {})[arm] = score_arm(instance, run_dir, arm, cfg, record["run_id"] + "-refilter")
            write_json(run_dir / "run.json", record)
            append_jsonl(BENCHMARK_ROOT / cfg.get("results_dir", "results") / "results.jsonl", result_row(instance, record, arm))
    log_event("patch.refilter.done", run_id=args.run_id, scores={a: s.get("resolved") for a, s in record.get("scores", {}).items()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
