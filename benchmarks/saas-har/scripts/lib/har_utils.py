"""HAR CLI helpers: scaffold, doctor, launch, verify, maintain, teardown, gate."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from .common import benchmark_config, load_benchmark_env, read_json, run_command

HAR_EPHEMERAL_SUBDIRS = frozenset({"slots", "runs", "logs", "artifacts", "maintain", "migrate"})

WEB_SIGNALS = (
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    "Dockerfile",
    "frontend",
    "backend",
    "manage.py",
)
WEB_DEPS = ("fastapi", "django", "flask", "uvicorn", "next", "vite", "react", "vue", "express", "nuxt", "svelte", "electron")


def har_base() -> list[str]:
    env = load_benchmark_env()
    if env.get("HAR_BIN"):
        return [env["HAR_BIN"]]
    which = shutil.which("har")
    if which:
        return [which]
    raise RuntimeError("har CLI not found on PATH (npm install -g @osfactory/har@latest)")


def har(*args: str, cwd: Path, timeout: int = 1800, env: dict[str, str] | None = None):
    return run_command([*har_base(), *args], cwd=cwd, timeout=timeout, env=env or load_benchmark_env())


def infer_profile(repo_dir: Path, repo: str) -> str:
    override = (benchmark_config().get("har_profile_override") or {}).get(repo)
    if override:
        return override
    for name in WEB_SIGNALS:
        if (repo_dir / name).exists():
            return "default"
    for manifest in ("package.json", "pyproject.toml", "requirements.txt"):
        path = repo_dir / manifest
        if path.exists():
            text = path.read_text(encoding="utf-8", errors="replace").lower()
            if any(dep in text for dep in WEB_DEPS):
                return "default"
    return "cli"


def init_scaffold(repo_dir: Path, profile: str) -> dict[str, Any]:
    extra = list(benchmark_config().get("har_init_extra_args") or [])
    result = har("env", "init", "--profile", profile, *extra, cwd=repo_dir, timeout=600)
    return {"ok": result.returncode == 0, "profile": profile, "stdout": result.stdout[-4000:], "stderr": result.stderr[-4000:]}


def read_adapt_prompt(repo_dir: Path) -> str:
    path = repo_dir / ".har" / "ADAPT-PROMPT.md"
    return path.read_text(encoding="utf-8").strip() if path.exists() else "(ADAPT-PROMPT.md missing)"


def read_profile(repo_dir: Path) -> str | None:
    ledger = repo_dir / ".har" / "plugins.json"
    if ledger.exists():
        try:
            return read_json(ledger).get("profile")
        except Exception:
            return None
    return None


def _parse_json_output(stdout: str) -> Any:
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        brace = stdout.find("{")
        if brace >= 0:
            try:
                return json.loads(stdout[brace:])
            except json.JSONDecodeError:
                return None
    return None


def doctor(repo_dir: Path) -> dict[str, Any]:
    result = har("env", "doctor", "--json", cwd=repo_dir, timeout=300)
    return {
        "ok": result.returncode == 0,
        "exit_code": result.returncode,
        "json": _parse_json_output(result.stdout),
        "stdout": result.stdout[-6000:],
        "stderr": result.stderr[-3000:],
    }


def slot_workdir(repo_dir: Path, agent_id: int = 1) -> Path | None:
    slot = repo_dir / ".har" / "slots" / f"agent-{agent_id}.json"
    if not slot.exists():
        return None
    data = read_json(slot)
    for key in ("workDir", "work_dir", "worktreePath", "worktree_path"):
        value = data.get(key)
        if value and Path(value).exists():
            return Path(value)
    return None


def launch(repo_dir: Path, agent_id: int = 1, timeout: int = 1800) -> dict[str, Any]:
    result = har("env", "launch", str(agent_id), cwd=repo_dir, timeout=timeout)
    workdir = slot_workdir(repo_dir, agent_id)
    if workdir is None:
        match = re.search(r"(?:WORK DIR|work dir|workDir)[^\n]*?(/[^\s'\"]+)", result.stdout + result.stderr, re.IGNORECASE)
        if match and Path(match.group(1)).exists():
            workdir = Path(match.group(1))
    agent_env = (workdir / f".env.agent.{agent_id}") if workdir else None
    return {
        "ok": result.returncode == 0 and workdir is not None,
        "exit_code": result.returncode,
        "workdir": str(workdir) if workdir else None,
        "agent_env_exists": bool(agent_env and agent_env.exists()),
        "stdout": result.stdout[-6000:],
        "stderr": result.stderr[-4000:],
    }


def verify(repo_dir: Path, agent_id: int = 1, *, full: bool, timeout: int = 3600) -> dict[str, Any]:
    args = ["env", "verify", str(agent_id), "--json"]
    if full:
        args.append("--full")
    result = har(*args, cwd=repo_dir, timeout=timeout)
    return {
        "ok": result.returncode == 0,
        "full": full,
        "exit_code": result.returncode,
        "json": _parse_json_output(result.stdout),
        "stdout": result.stdout[-8000:],
        "stderr": result.stderr[-4000:],
    }


def teardown(repo_dir: Path, agent_id: int = 1, *, delete_branch: bool = True) -> dict[str, Any]:
    args = ["env", "teardown", str(agent_id)]
    if delete_branch:
        args.append("--delete-branch")
    result = har(*args, cwd=repo_dir, timeout=900)
    return {"ok": result.returncode == 0, "stdout": result.stdout[-3000:], "stderr": result.stderr[-2000:]}


def maintain_report(repo_dir: Path) -> dict[str, Any]:
    """Drift report: har env maintain (non-interactive). Also refreshes .har/ADAPT-PROMPT.md."""
    result = har(
        "env", "maintain", "--yes", "--no-cursor-rule", "--agents", "claude", "--commit-gate", "never",
        cwd=repo_dir, timeout=600,
    )
    return {"exit_code": result.returncode, "stdout": result.stdout[-12000:], "stderr": result.stderr[-4000:]}


def slot_branch(repo_dir: Path, agent_id: int = 1) -> str | None:
    """Session branch of the slot, from the registry or from git branch names."""
    slot = repo_dir / ".har" / "slots" / f"agent-{agent_id}.json"
    if slot.exists():
        try:
            data = read_json(slot)
        except Exception:
            data = {}
        for key in ("branch", "sessionBranch", "session_branch"):
            if data.get(key):
                return str(data[key])
    result = run_command(["git", "-C", str(repo_dir), "branch", "--list", f"*har-agent-{agent_id}*", "--format=%(refname:short)"])
    names = [n.strip() for n in result.stdout.splitlines() if n.strip()]
    return names[-1] if names else None


def gate(repo_dir: Path, *, timeout_seconds: int, require_full: bool = True) -> dict[str, Any]:
    """Readiness gate: doctor → launch → verify quick → verify --full. Slot stays launched on success.

    With require_full=False the full tier is still run and recorded, but readiness only needs
    doctor + launch + quick verify (used as the fallback once adaptation rounds are exhausted).
    """
    teardown(repo_dir)
    doc = doctor(repo_dir)
    out: dict[str, Any] = {"doctor": doc, "launch": None, "verify_quick": None, "verify_full": None, "ready": False, "require_full": require_full}
    if not doc["ok"]:
        out["failed_stage"] = "doctor"
        return out
    la = launch(repo_dir, timeout=timeout_seconds)
    out["launch"] = la
    if not la["ok"]:
        out["failed_stage"] = "launch"
        teardown(repo_dir)
        return out
    vq = verify(repo_dir, full=False, timeout=timeout_seconds)
    out["verify_quick"] = vq
    if not vq["ok"]:
        out["failed_stage"] = "verify_quick"
        teardown(repo_dir)
        return out
    vf = verify(repo_dir, full=True, timeout=timeout_seconds)
    out["verify_full"] = vf
    out["full_ok"] = bool(vf["ok"])
    if not vf["ok"] and require_full:
        out["failed_stage"] = "verify_full"
        teardown(repo_dir)
        return out
    if not vf["ok"]:
        out["failed_stage"] = "verify_full(soft)"
    out["ready"] = True
    out["workdir"] = la["workdir"]
    # Task-blind record of what launching + verifying dirties in a session worktree
    # (generated route trees, lockfiles, slot databases). Scoring excludes these unless
    # the solving agent edited them itself.
    from .patch import dirty_snapshot

    if la["workdir"]:
        out["side_effect_files"] = dirty_snapshot(Path(la["workdir"]))
    # Protocol v2: the solving agent must find the slot un-launched, exactly as a
    # developer would after cloning the repository.
    teardown(repo_dir)
    return out


def format_gate_failure(gate_result: dict[str, Any]) -> str:
    stage = gate_result.get("failed_stage", "unknown")
    parts = [f"## Runner gate failed at stage: `{stage}`", ""]
    doc = gate_result.get("doctor") or {}
    if stage == "doctor":
        parts += ["### har env doctor --json", "```", (doc.get("stdout") or doc.get("stderr") or "")[-4000:], "```"]
    la = gate_result.get("launch") or {}
    if la:
        parts += ["### har env launch 1 (tail)", "```", (la.get("stdout") or "")[-3000:], (la.get("stderr") or "")[-2000:], "```"]
    for key, title in (("verify_quick", "har env verify 1 --json"), ("verify_full", "har env verify 1 --full --json")):
        v = gate_result.get(key)
        if v:
            parts += [f"### {title} (exit {v.get('exit_code')})", "```", (v.get("stdout") or "")[-5000:], (v.get("stderr") or "")[-2000:], "```"]
    return "\n".join(parts)


def copy_har_artifacts(repo_dir: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for rel in (".har/runs", ".har/artifacts", ".har/logs", ".har/slots", ".har/maintain"):
        src = repo_dir / rel
        if src.exists():
            shutil.copytree(src, dest / rel, dirs_exist_ok=True, ignore_dangling_symlinks=True)


def harness_env_value(repo_dir: Path, key: str) -> str | None:
    path = repo_dir / ".har" / "harness.env"
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def infra_down(repo_dir: Path) -> dict[str, Any]:
    """Best-effort: stop the shared Docker services HAR's setup-infra started for this harness."""
    compose = repo_dir / ".har" / "docker-compose.agent.yml"
    project = harness_env_value(repo_dir, "HARNESS_PROJECT_NAME")
    if not compose.exists() or not project:
        return {"skipped": True}
    # HAR names the compose project `har-<HARNESS_PROJECT_NAME>`; try both spellings.
    results = {}
    for name in (f"har-{project}", project):
        result = run_command(
            ["docker", "compose", "-p", name, "-f", str(compose), "down", "--remove-orphans"],
            cwd=repo_dir,
            timeout=600,
        )
        results[name] = {"exit_code": result.returncode, "stderr": result.stderr[-800:]}
    return results
