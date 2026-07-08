"""HAR CLI helpers for the SWE-bench benchmark."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from .common import har_cmd, load_benchmark_env, read_json, run_command


def har_launch_env(env: dict[str, str] | None = None) -> dict[str, str]:
    """Env vars for non-interactive HAR launch/replace from the benchmark runner."""
    merged = dict(env or load_benchmark_env())
    merged["HAR_CONFIRM_REPLACE"] = "1"
    return merged


def har_init_scaffold(repo_path: Path, profile: str, env: dict[str, str] | None = None) -> None:
    launch = repo_path / ".har" / "launch.sh"
    if launch.exists():
        return
    run_command(
        [*har_cmd("init", "--profile", profile, env=env)],
        cwd=repo_path,
        check=True,
    )


def read_har_slot_workdir(harness_root: Path, agent_id: int = 1) -> Path | None:
    slot_path = harness_root / ".har" / "slots" / f"agent-{agent_id}.json"
    if not slot_path.exists():
        return None
    data = read_json(slot_path)
    for key in ("workDir", "work_dir", "worktreePath", "worktree_path"):
        value = data.get(key)
        if value:
            path = Path(value)
            if path.exists():
                return path
    return None


def har_launch_slot(
    harness_root: Path,
    agent_id: int = 1,
    timeout_seconds: int = 3600,
    env: dict[str, str] | None = None,
) -> tuple[bool, Path | None, str]:
    launch_env = har_launch_env(env)
    result = run_command(
        [*har_cmd("launch", str(agent_id), "--replace", "--force", env=launch_env)],
        cwd=harness_root,
        timeout=timeout_seconds,
    )
    if result.returncode != 0:
        return False, None, result.stderr or result.stdout
    workdir = read_har_slot_workdir(harness_root, agent_id)
    if workdir and workdir.exists():
        return True, workdir, result.stdout
    combined = f"{result.stdout}\n{result.stderr}"
    match = re.search(r"WORK DIR.*?(\/[^\s]+)", combined, re.IGNORECASE)
    if match:
        path = Path(match.group(1))
        if path.exists():
            return True, path, combined
    return False, None, combined


def har_verify(
    harness_root: Path,
    agent_id: int = 1,
    *,
    full: bool = False,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    args = [*har_cmd("verify", str(agent_id), env=env)]
    if full:
        args.append("--full")
    result = run_command(args, cwd=harness_root)
    return {
        "verified": result.returncode == 0,
        "full": full,
        "details": f"har env verify {agent_id}" + (" --full" if full else ""),
        "stdout": result.stdout[-8000:],
        "stderr": result.stderr[-8000:],
        "exit_code": result.returncode,
    }


def har_teardown_slot(harness_root: Path, agent_id: int = 1, env: dict[str, str] | None = None) -> None:
    run_command([*har_cmd("teardown", str(agent_id), env=env)], cwd=harness_root)


def har_validate_ready(
    harness_root: Path,
    agent_id: int = 1,
    *,
    timeout_seconds: int = 3600,
    env: dict[str, str] | None = None,
    verify_full: bool = False,
) -> dict[str, Any]:
    """Runner gate: teardown, launch, and quick verify before the fix stage."""
    launch_env = har_launch_env(env)
    har_teardown_slot(harness_root, agent_id=agent_id, env=launch_env)

    launch_ok, workdir, launch_log = har_launch_slot(
        harness_root,
        agent_id=agent_id,
        timeout_seconds=timeout_seconds,
        env=launch_env,
    )

    if launch_ok:
        verify_result = har_verify(
            harness_root,
            agent_id=agent_id,
            full=verify_full,
            env=launch_env,
        )
    else:
        verify_result = {
            "verified": False,
            "full": verify_full,
            "details": "skipped (launch failed)",
            "stdout": "",
            "stderr": "",
            "exit_code": -1,
        }

    agent_env = workdir / f".env.agent.{agent_id}" if workdir else None
    ready = bool(
        launch_ok
        and workdir is not None
        and workdir.exists()
        and agent_env is not None
        and agent_env.exists()
        and verify_result["verified"]
    )

    return {
        "ready": ready,
        "launch_ok": launch_ok,
        "workdir": str(workdir) if workdir else None,
        "launch_log": launch_log[-4000:],
        "verify": verify_result,
        "agent_env_exists": agent_env.exists() if agent_env else False,
    }


def har_runs_exist(harness_root: Path) -> bool:
    runs_dir = harness_root / ".har" / "runs"
    if not runs_dir.exists():
        return False
    return any(runs_dir.rglob("*.json"))


def copy_har_artifacts(harness_root: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for rel in (".har/runs", ".har/artifacts", ".har/logs", ".har/slots"):
        src = harness_root / rel
        if src.exists():
            shutil.copytree(src, dest / rel, dirs_exist_ok=True)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        try:
            return _json_safe(value.model_dump(mode="json"))
        except TypeError:
            return _json_safe(value.model_dump())
    return str(value)


def serialize_turn_result(result: Any) -> dict[str, Any]:
    usage = getattr(result, "usage", None)
    usage_dict = _json_safe(usage) if usage is not None else None
    items = [_json_safe(item) for item in (getattr(result, "items", []) or [])]
    error = getattr(result, "error", None)
    error_dict = _json_safe(error) if error is not None else None

    return {
        "id": getattr(result, "id", None),
        "status": str(getattr(result, "status", None)),
        "error": error_dict,
        "started_at": getattr(result, "started_at", None),
        "completed_at": getattr(result, "completed_at", None),
        "duration_ms": getattr(result, "duration_ms", None),
        "final_response": getattr(result, "final_response", None),
        "usage": usage_dict,
        "items": items,
    }
