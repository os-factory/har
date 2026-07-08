"""Shared utilities for the SWE-bench HAR benchmark."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

import yaml

BENCHMARK_ROOT = Path(__file__).resolve().parents[2]
HAR_PROJECT_ROOT = BENCHMARK_ROOT.parents[1]

EVALUATOR_ONLY_FIELDS = frozenset(
    {
        "patch",
        "test_patch",
        "FAIL_TO_PASS",
        "PASS_TO_PASS",
        "environment_setup_commit",
    }
)


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
    return env


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def render_template(path: Path, values: dict[str, Any]) -> str:
    text = path.read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace(f"{{{{{key}}}}}", str(value))
    return text


def run_command(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(cmd)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def resolve_har_base_cmd(env: dict[str, str] | None = None) -> list[str]:
    env = env or load_benchmark_env()
    har_bin = env.get("HAR_BIN")
    if har_bin:
        return [har_bin]
    which = shutil.which("har")
    if which:
        return [which]
    dist = HAR_PROJECT_ROOT / "dist" / "index.js"
    if dist.exists():
        return ["node", str(dist)]
    raise RuntimeError("har CLI not found; install @osfactory/har or set HAR_BIN")


def har_cmd(*args: str, env: dict[str, str] | None = None) -> list[str]:
    return [*resolve_har_base_cmd(env), "env", *args]


def sanitize_instance_row(row: dict[str, Any]) -> dict[str, Any]:
    """Return agent-safe metadata without evaluator-only gold fields."""
    return {key: value for key, value in row.items() if key not in EVALUATOR_ONLY_FIELDS}


def evaluator_row(row: dict[str, Any]) -> dict[str, Any]:
    """Keep evaluator fields for scoring only."""
    return {key: row.get(key) for key in EVALUATOR_ONLY_FIELDS if key in row}


def repo_git_url(repo_slug: str) -> str:
    return f"https://github.com/{repo_slug}.git"


def clone_repo_at_commit(repo_slug: str, base_commit: str, dest: Path, cache_dir: Path) -> Path:
    if dest.exists():
        shutil.rmtree(dest)
    ensure_dir(dest.parent)
    cache_key = re.sub(r"[^a-zA-Z0-9._-]+", "-", repo_slug)
    cache_repo = cache_dir / cache_key
    if not cache_repo.exists():
        run_command(["git", "clone", repo_git_url(repo_slug), str(cache_repo)], check=True)
    run_command(["git", "fetch", "--all", "--tags"], cwd=cache_repo, check=False)
    run_command(["git", "clone", str(cache_repo), str(dest)], check=True)
    run_command(["git", "checkout", base_commit], cwd=dest, check=True)
    return dest


def slugify(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def new_run_id(instance_id: str) -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    return f"{stamp}-{slugify(instance_id)}"


def write_predictions(path: Path, instance_id: str, model_name: str, model_patch: str) -> None:
    ensure_dir(path.parent)
    record = {
        "instance_id": instance_id,
        "model_name_or_path": model_name,
        "model_patch": model_patch,
    }
    path.write_text(json.dumps(record) + "\n", encoding="utf-8")
