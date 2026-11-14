"""Shared utilities for the SaaS/HAR paired benchmark."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

import yaml

BENCHMARK_ROOT = Path(__file__).resolve().parents[2]
HAR_PROJECT_ROOT = BENCHMARK_ROOT.parents[1]
PROMPTS_DIR = BENCHMARK_ROOT / "prompts"


def load_yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def benchmark_config() -> dict[str, Any]:
    return load_yaml(BENCHMARK_ROOT / "config.yaml")


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def load_benchmark_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update(load_env_file(BENCHMARK_ROOT / ".env.local"))
    # A nested Claude Code session must not believe it is running inside another one.
    for key in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"):
        env.pop(key, None)
    # `uv run scripts/...` exports the benchmark venv; the harnesses' own `uv` must not inherit it.
    for key in ("VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT", "PYTHONPATH"):
        env.pop(key, None)
    return env


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, indent=2, default=str) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    ensure_dir(path.parent)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, default=str) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def log_event(kind: str, **fields: Any) -> None:
    """Append a timestamped event to results/events.jsonl (the paper trail) and echo it."""
    cfg = benchmark_config()
    record = {"ts": now_iso(), "event": kind}
    record.update(fields)
    append_jsonl(BENCHMARK_ROOT / cfg.get("results_dir", "results") / "events.jsonl", record)
    shown = " ".join(f"{k}={v}" for k, v in fields.items() if k != "detail")
    print(f"[{record['ts']}] {kind} {shown}", flush=True)


def render_template(path: Path, values: dict[str, Any]) -> str:
    text = path.read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace(f"{{{{{key}}}}}", str(value))
    return text


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def run_command(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
    check: bool = False,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a command in its own process group so a timeout stops its children as well."""
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(input=input_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        _stop_group(proc)
        stdout, stderr = proc.communicate()
        result = subprocess.CompletedProcess(cmd, -9, stdout, (stderr or "") + "\n[timeout]")
        if check:
            raise RuntimeError(f"Command timed out: {' '.join(cmd)}")
        return result
    result = subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(cmd)}\n"
            f"stdout:\n{result.stdout[-4000:]}\nstderr:\n{result.stderr[-4000:]}"
        )
    return result


def _stop_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.time() + 15
    while time.time() < deadline and proc.poll() is None:
        time.sleep(0.5)
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def slugify(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def repo_slug(repo: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", repo)


def new_run_id(instance_id: str) -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    return f"{stamp}-{slugify(instance_id)}"


def repo_git_url(repo: str) -> str:
    return f"https://github.com/{repo}.git"


_LOCK_HANDLE = None


def acquire_runner_lock() -> None:
    """One runner per machine.

    HAR slot 1, its port lanes and the shared Docker infra are global per repository, so two
    concurrent runners tear down each other's slots (observed 2026-09-10: a duplicated smoke run
    lost its worktree mid-session). Fail fast instead.
    """
    global _LOCK_HANDLE
    import fcntl

    cfg = benchmark_config()
    lock_path = ensure_dir(BENCHMARK_ROOT / cfg.get("results_dir", "results")) / ".runner.lock"
    handle = lock_path.open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.seek(0)
        holder = handle.read().strip() or "unknown"
        raise SystemExit(f"another benchmark runner is active ({holder}); refusing to run concurrently")
    handle.seek(0)
    handle.truncate()
    handle.write(f"pid={os.getpid()} started={now_iso()}\n")
    handle.flush()
    _LOCK_HANDLE = handle  # keep the fd open for the life of the process


def free_gb(path: Path | None = None) -> float:
    usage = shutil.disk_usage(str(path or work_root().parent))
    return usage.free / (1024**3)


def work_root() -> Path:
    """Root for agent-visible checkouts, outside this repository (see config work_root)."""
    cfg = benchmark_config()
    return Path(cfg.get("work_root") or (BENCHMARK_ROOT / "work"))


def work_id(run_id: str) -> str:
    """Opaque directory name: an agent must not be able to read the instance from its cwd."""
    return hashlib.sha1(run_id.encode("utf-8")).hexdigest()[:10]


def run_work_dir(run_id: str) -> Path:
    return work_root() / work_id(run_id)


def bare_cache_path(repo: str) -> Path:
    cfg = benchmark_config()
    return BENCHMARK_ROOT / cfg.get("repo_cache_dir", ".repo-cache") / repo_slug(repo)


def ensure_bare_cache(repo: str, *, commit: str | None = None) -> Path:
    bare = bare_cache_path(repo)
    if not bare.exists():
        ensure_dir(bare.parent)
        run_command(["git", "clone", "--bare", repo_git_url(repo), str(bare)], check=True, timeout=3600)
    if commit:
        have = run_command(["git", "-C", str(bare), "cat-file", "-e", f"{commit}^{{commit}}"])
        if have.returncode != 0:
            run_command(["git", "-C", str(bare), "fetch", "origin", "+refs/heads/*:refs/heads/*", "--tags"], timeout=3600)
    return bare


def clone_repo_at_commit(repo: str, base_commit: str, dest: Path) -> Path:
    """Fresh checkout of repo@base_commit from the local bare cache (network only on a miss)."""
    if dest.exists():
        shutil.rmtree(dest)
    ensure_dir(dest.parent)
    bare = ensure_bare_cache(repo, commit=base_commit)
    run_command(["git", "clone", "--quiet", str(bare), str(dest)], check=True, timeout=1800)
    run_command(["git", "-C", str(dest), "remote", "set-url", "origin", repo_git_url(repo)], check=False)
    run_command(["git", "-C", str(dest), "checkout", "--quiet", base_commit], check=True)
    # A named branch keeps worktree naming stable (a detached HEAD has no base name).
    # The name is neutral on purpose: it is visible to the solving agent.
    branch = benchmark_config().get("base_branch_name", "task-base")
    run_command(["git", "-C", str(dest), "checkout", "--quiet", "-B", branch], check=True)
    run_command(["git", "-C", str(dest), "config", "user.name", "dev"], check=True)
    run_command(["git", "-C", str(dest), "config", "user.email", "dev@localhost"], check=True)
    return dest


def commit_date(repo: str, commit: str) -> int | None:
    bare = ensure_bare_cache(repo, commit=commit)
    result = run_command(["git", "-C", str(bare), "log", "-1", "--format=%ct", commit])
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return int(result.stdout.strip())


def tool_versions() -> dict[str, str]:
    def _v(cmd: list[str]) -> str:
        try:
            r = run_command(cmd, timeout=60)
            text = (r.stdout or r.stderr).strip()
            return text.splitlines()[0] if text else ""
        except Exception as exc:  # pragma: no cover
            return f"error: {exc}"

    return {
        "har": _v(["har", "--version"]),
        "claude": _v(["claude", "--version"]),
        "node": _v(["node", "--version"]),
        "python": _v(["python3", "--version"]),
        "docker": _v(["docker", "--version"]),
        "har_project_sha": _v(["git", "-C", str(HAR_PROJECT_ROOT), "rev-parse", "--short", "HEAD"]),
    }
