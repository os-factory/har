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
    # Non-interactive: skip cursor-rule / agent-skills prompts (tmux/SSH is a TTY).
    # Also tolerate exit 1 from a known yargs --no-agents quirk if scaffold landed.
    result = run_command(
        [
            *har_cmd(
                "init",
                "--profile",
                profile,
                "--no-cursor-rule",
                "--no-agents",
                env=env,
            )
        ],
        cwd=repo_path,
        check=False,
    )
    if launch.exists():
        return
    raise RuntimeError(
        f"har env init failed ({result.returncode}): {' '.join(result.args) if hasattr(result, 'args') else 'init'}\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )


PROFILE_HINTS: dict[str, str] = {
    "default": (
        "Web app profile (SaaS/full-stack) — Docker Compose for shared infra "
        "(HARNESS_INFRA_SERVICES), PM2 for the primary application only, git worktree "
        "per agent slot by default. Launch provisions toolchain via harness.env and "
        "writes paths to .env.agent.<id>. Identify the primary app agents modify."
    ),
    "cli": (
        "CLI/library profile (typical SWE-bench) — no PM2. Optional Docker Compose via "
        "HARNESS_INFRA_SERVICES. Git worktree by default. Launch provisions toolchain "
        "declaratively (HARNESS_ECOSYSTEM auto-detects common ecosystems); verify must "
        "use resolved tool paths from .env.agent.<id>, never hardcoded interpreter or "
        "package-manager paths."
    ),
    "ios": (
        "iOS mobile app profile — xcodebuild + iOS Simulator in an isolated git worktree. "
        "Set HARNESS_XCODE_SCHEME, workspace/project, HARNESS_SIMULATOR_NAME, "
        "HARNESS_BUNDLE_ID. Launch writes XCODEBUILD_BIN to .env.agent.<id>; verify uses it."
    ),
}


def _resolve_init_adapt_template() -> Path | None:
    from .common import HAR_PROJECT_ROOT

    for candidate in (
        HAR_PROJECT_ROOT / "dist" / "templates" / "adaptation-prompt-init.md",
        HAR_PROJECT_ROOT / "src" / "templates" / "adaptation-prompt-init.md",
    ):
        if candidate.exists():
            return candidate
    return None


def build_init_adapt_prompt(profile: str) -> str:
    """Mirror har's buildInitAdaptationPrompt when .har/ADAPT-PROMPT.md is missing."""
    template_path = _resolve_init_adapt_template()
    if template_path is None:
        raise RuntimeError(
            "adaptation-prompt-init.md not found in HAR checkout; run npm run build"
        )
    content = template_path.read_text(encoding="utf-8")
    hint = PROFILE_HINTS.get(profile, PROFILE_HINTS["default"])
    return (
        content.replace("{{PROFILE}}", profile).replace("{{PROFILE_HINT}}", hint)
    )


def read_har_adapt_prompt(harness_root: Path, profile: str) -> str:
    """Load the init adaptation prompt written by har env init."""
    adapt_path = harness_root / ".har" / "ADAPT-PROMPT.md"
    if adapt_path.exists():
        return adapt_path.read_text(encoding="utf-8").strip()
    return build_init_adapt_prompt(profile)


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


def har_validate_launch(
    harness_root: Path,
    agent_id: int = 1,
    *,
    timeout_seconds: int = 3600,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Pre-fix gate (launch): teardown, launch, workdir, and agent env file."""
    launch_env = har_launch_env(env)
    har_teardown_slot(harness_root, agent_id=agent_id, env=launch_env)

    launch_ok, workdir, launch_log = har_launch_slot(
        harness_root,
        agent_id=agent_id,
        timeout_seconds=timeout_seconds,
        env=launch_env,
    )

    agent_env = workdir / f".env.agent.{agent_id}" if workdir else None
    agent_env_exists = bool(agent_env and agent_env.exists())
    launch_ready = bool(
        launch_ok
        and workdir is not None
        and workdir.exists()
        and agent_env_exists
    )

    return {
        "ready": launch_ready,
        "launch_ok": launch_ok,
        "workdir": str(workdir) if workdir else None,
        "launch_log": launch_log[-4000:],
        "agent_env_exists": agent_env_exists,
    }


def har_validate_smoke(
    harness_root: Path,
    agent_id: int = 1,
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Pre-fix gate (smoke): quick verify only — compile/import/build, not full test suites."""
    verify_result = har_verify(harness_root, agent_id=agent_id, full=False, env=env)
    return {
        "ready": verify_result["verified"],
        "smoke_ok": verify_result["verified"],
        "verify": verify_result,
    }


def har_validate_ready(
    harness_root: Path,
    agent_id: int = 1,
    *,
    timeout_seconds: int = 3600,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Pre-fix gate: launch readiness + quick smoke verify before the fix stage."""
    launch = har_validate_launch(
        harness_root,
        agent_id=agent_id,
        timeout_seconds=timeout_seconds,
        env=env,
    )

    if launch["ready"]:
        smoke = har_validate_smoke(harness_root, agent_id=agent_id, env=env)
    else:
        smoke = {
            "ready": False,
            "smoke_ok": False,
            "verify": {
                "verified": False,
                "full": False,
                "details": "skipped (launch failed)",
                "stdout": "",
                "stderr": "",
                "exit_code": -1,
            },
        }

    ready = bool(launch["ready"] and smoke["ready"])

    return {
        "ready": ready,
        "launch": launch,
        "smoke": smoke,
        # Backward-compatible fields for gate failure formatting
        "launch_ok": launch["launch_ok"],
        "workdir": launch["workdir"],
        "launch_log": launch["launch_log"],
        "agent_env_exists": launch["agent_env_exists"],
        "verify": smoke["verify"],
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
