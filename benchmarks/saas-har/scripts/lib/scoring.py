"""Scoring adapters: PrototypeBench harness (vendored) and the official SWE-bench harness."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from .common import (
    BENCHMARK_ROOT,
    benchmark_config,
    ensure_bare_cache,
    ensure_dir,
    repo_slug,
    run_command,
    work_root,
    write_json,
)

PBENCH_DIR = BENCHMARK_ROOT / ".vendor" / "prototypebench"
PBENCH_ADAPTER = BENCHMARK_ROOT / "scripts" / "pbench_score_adapter.py"
# Any local image with a shell; used only to delete root-owned files the scorer container wrote.
ROOT_RM_IMAGE = "prototypebench/backend:latest"


def force_remove(path: Path) -> bool:
    """Delete a scorer workspace, including files the scorer's root container created."""
    path = path.resolve()  # docker -v needs an absolute path
    if not path.exists():
        return True
    shutil.rmtree(path, ignore_errors=True)
    if path.exists():
        run_command(
            ["docker", "run", "--rm", "-v", f"{path.parent}:/target", ROOT_RM_IMAGE, "rm", "-rf", f"/target/{path.name}"],
            timeout=600,
        )
        shutil.rmtree(path, ignore_errors=True)
    return not path.exists()


def score_prototypebench(instance: dict[str, Any], patch_text: str, out_dir: Path, *, timeout: int = 3600) -> dict[str, Any]:
    hidden = instance["hidden"]
    f2p = hidden.get("fail_to_pass") or {}
    p2p = hidden.get("pass_to_pass") or {}
    ensure_dir(out_dir)
    patch_path = out_dir / "model.patch"
    patch_path.write_text(patch_text, encoding="utf-8")
    result: dict[str, Any] = {"scorer": "prototypebench", "instance_id": instance["instance_id"], "resolved": False}

    if instance["extra"].get("stack_domain") == "frontend_only" or (f2p.get("frontend") and not f2p.get("backend")):
        result.update({"error": "frontend (Playwright/Electron) scoring not wired in this pilot", "skipped": True})
        write_json(out_dir / "score.json", result)
        return result

    # The upstream scorer bind-mounts this workspace into a container that runs as root, so it
    # cannot be shared between arms (a later `git clean` would trip over root-owned .venv files).
    # One workspace per arm, cloned from the local bare cache and deleted right after scoring.
    scorer_root = ensure_dir(work_root() / "scorer" / f"{repo_slug(instance['repo'])}-{out_dir.name}-{instance['instance_id'][-24:]}")
    repo_dir = scorer_root / "repo"
    if not repo_dir.exists():
        bare = ensure_bare_cache(instance["repo"], commit=instance["base_commit"])
        run_command(["git", "clone", "--quiet", str(bare), str(repo_dir)], check=True, timeout=1800)
        run_command(["git", "-C", str(repo_dir), "remote", "set-url", "origin", f"https://github.com/{instance['repo']}.git"])
    spec = {
        "instance_id": instance["instance_id"],
        "repo": instance["repo"],
        "base_commit": instance["base_commit"],
        "test_patch": hidden.get("test_patch_backend") or hidden.get("test_patch") or "",
        "fail_to_pass": list(f2p.get("backend") or []),
        "pass_to_pass": list(p2p.get("backend") or []),
        "patch_file": str(patch_path),
        "work_root": str(scorer_root),
    }
    spec_path = out_dir / "spec.json"
    write_json(spec_path, spec)
    proc = run_command(
        ["uv", "run", "--quiet", "--project", str(PBENCH_DIR), "python", str(PBENCH_ADAPTER), "--spec", str(spec_path), "--out", str(out_dir / "score.json")],
        cwd=PBENCH_DIR,
        timeout=timeout,
    )
    result["adapter_exit_code"] = proc.returncode
    result["adapter_stdout_tail"] = proc.stdout[-4000:]
    result["adapter_stderr_tail"] = proc.stderr[-4000:]
    # Keep this arm's pytest evidence: the shared workspace is overwritten by the next arm.
    upstream_out = scorer_root / "out"
    if upstream_out.exists():
        shutil.copytree(upstream_out, out_dir / "out", dirs_exist_ok=True)
    score_path = out_dir / "score.json"
    if score_path.exists():
        try:
            data = json.loads(score_path.read_text(encoding="utf-8"))
            result.update(data)
            result["resolved"] = bool(data.get("score") == 1)
        except json.JSONDecodeError:
            result["error"] = "score.json unreadable"
    else:
        result["error"] = f"adapter produced no score.json (exit {proc.returncode})"
    if not benchmark_config().get("keep_score_work", False):
        result["score_work_removed"] = force_remove(scorer_root)
    write_json(out_dir / "score.summary.json", result)
    return result


def score_swebench(instance: dict[str, Any], patch_text: str, out_dir: Path, *, model_name: str, run_id: str, timeout: int = 5400) -> dict[str, Any]:
    ensure_dir(out_dir)
    preds = out_dir / "predictions.jsonl"
    preds.write_text(json.dumps({"instance_id": instance["instance_id"], "model_name_or_path": model_name, "model_patch": patch_text}) + "\n", encoding="utf-8")
    result: dict[str, Any] = {"scorer": "swebench", "instance_id": instance["instance_id"], "resolved": False}
    if not patch_text.strip():
        result.update({"error": "empty patch", "skipped": True})
        write_json(out_dir / "score.summary.json", result)
        return result
    cmd = [
        "uv", "run", "--quiet", "--project", str(BENCHMARK_ROOT), "python", "-m", "swebench.harness.run_evaluation",
        "--dataset_name", instance["extra"]["hf_name"],
        "--split", instance["extra"]["split"],
        "--predictions_path", str(preds),
        "--instance_ids", instance["instance_id"],
        "--run_id", run_id,
        "--max_workers", "1",
        "--timeout", "1800",
        "--report_dir", str(out_dir),
    ]
    proc = run_command(cmd, cwd=out_dir, timeout=timeout)
    result["harness_exit_code"] = proc.returncode
    result["harness_stdout_tail"] = proc.stdout[-4000:]
    result["harness_stderr_tail"] = proc.stderr[-4000:]
    report = None
    for candidate in sorted(out_dir.glob(f"*{run_id}*.json")):
        try:
            report = json.loads(candidate.read_text(encoding="utf-8"))
            result["report_path"] = str(candidate)
            break
        except json.JSONDecodeError:
            continue
    if report:
        result["resolved"] = instance["instance_id"] in (report.get("resolved_ids") or [])
        result["report"] = {k: report.get(k) for k in ("total_instances", "submitted_instances", "completed_instances", "resolved_instances", "unresolved_instances", "error_instances", "empty_patch_instances")}
        # per-instance report (test status) lives under logs/run_evaluation/<run_id>/<model>/<instance>/report.json
        inst_reports = list(out_dir.glob(f"logs/run_evaluation/{run_id}/*/{instance['instance_id']}/report.json"))
        if inst_reports:
            try:
                result["instance_report"] = json.loads(inst_reports[0].read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
    else:
        result["error"] = "no evaluation report produced"
    write_json(out_dir / "score.summary.json", result)
    return result


def score_instance(instance: dict[str, Any], patch_text: str, out_dir: Path, *, model_name: str, run_id: str) -> dict[str, Any]:
    if instance["kind"] == "prototypebench":
        return score_prototypebench(instance, patch_text, out_dir)
    if instance["kind"] == "swebench":
        return score_swebench(instance, patch_text, out_dir, model_name=model_name, run_id=run_id)
    raise ValueError(instance["kind"])
