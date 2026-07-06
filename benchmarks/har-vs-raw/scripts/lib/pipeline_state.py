"""Campaign pipeline state for the v3 benchmark workflow."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from lib.common import BENCHMARK_ROOT, ensure_dir, now_iso, read_json, write_json

PHASES = (
    "fork",
    "clone",
    "harness_init",
    "harness_adapt",
    "harness_verify",
    "harness_push",
    "harness_approval",
    "select_issues",
    "run_raw",
    "run_har",
    "report",
)

PHASE_STATUS = ("pending", "running", "completed", "failed", "skipped", "blocked")

_lock = threading.Lock()


def v3_config() -> dict[str, Any]:
    from lib.common import load_yaml

    return load_yaml(BENCHMARK_ROOT / "config.v3.yaml")


def v3_repos() -> list[dict[str, Any]]:
    from lib.common import load_yaml

    data = load_yaml(BENCHMARK_ROOT / "repos.v3.yaml")
    return data["repos"]


def v3_repo_by_id(repo_id: str) -> dict[str, Any] | None:
    for repo in v3_repos():
        if repo["id"] == repo_id:
            return repo
    return None


def state_path() -> Path:
    cfg = v3_config()
    return BENCHMARK_ROOT / cfg.get("state_dir", "state/v3") / "campaign.json"


def logs_dir() -> Path:
    cfg = v3_config()
    return ensure_dir(BENCHMARK_ROOT / cfg.get("state_dir", "state/v3") / "logs")


def log_path(repo_id: str, phase: str) -> Path:
    return logs_dir() / f"{repo_id}-{phase}.log"


def default_phase() -> dict[str, Any]:
    return {"status": "pending", "started_at": None, "finished_at": None, "error": None, "log_file": None}


def default_repo_state(repo: dict[str, Any]) -> dict[str, Any]:
    return {
        "repo_id": repo["id"],
        "slug": f"{repo['owner']}/{repo['name']}",
        "upstream": f"{repo['upstream_owner']}/{repo['upstream_name']}",
        "fork_url": repo["url"],
        "harness_branch": v3_config().get("harness_branch", "benchmark/har-setup"),
        "harness_branch_url": None,
        "manual_approval": {"status": "pending", "approved_at": None, "notes": ""},
        "phases": {phase: default_phase() for phase in PHASES},
    }


def load_state() -> dict[str, Any]:
    path = state_path()
    if not path.exists():
        cfg = v3_config()
        return {
            "campaign_id": cfg.get("campaign_id", "har-vs-raw-v3"),
            "updated_at": now_iso(),
            "repos": {repo["id"]: default_repo_state(repo) for repo in v3_repos()},
        }
    return read_json(path)


def save_state(state: dict[str, Any]) -> None:
    with _lock:
        state["updated_at"] = now_iso()
        write_json(state_path(), state)


def get_repo_state(state: dict[str, Any], repo_id: str) -> dict[str, Any]:
    repos = state.setdefault("repos", {})
    if repo_id not in repos:
        repo = v3_repo_by_id(repo_id)
        if not repo:
            raise KeyError(f"Unknown repo id: {repo_id}")
        repos[repo_id] = default_repo_state(repo)
    return repos[repo_id]


def set_phase_status(
    state: dict[str, Any],
    repo_id: str,
    phase: str,
    status: str,
    *,
    error: str | None = None,
    log_file: str | None = None,
) -> None:
    if phase not in PHASES:
        raise ValueError(f"Unknown phase: {phase}")
    if status not in PHASE_STATUS:
        raise ValueError(f"Unknown status: {status}")
    repo = get_repo_state(state, repo_id)
    entry = repo["phases"].setdefault(phase, default_phase())
    entry["status"] = status
    if status == "running":
        entry["started_at"] = now_iso()
        entry["finished_at"] = None
        entry["error"] = None
    if status in {"completed", "failed", "skipped", "blocked"}:
        entry["finished_at"] = now_iso()
    if error is not None:
        entry["error"] = error
    if log_file is not None:
        entry["log_file"] = log_file


def phase_is_done(state: dict[str, Any], repo_id: str, phase: str) -> bool:
    repo = get_repo_state(state, repo_id)
    status = repo["phases"].get(phase, {}).get("status", "pending")
    return status in {"completed", "skipped"}


def approval_status(state: dict[str, Any], repo_id: str) -> str:
    return get_repo_state(state, repo_id)["manual_approval"]["status"]


def set_approval(state: dict[str, Any], repo_id: str, approved: bool, notes: str = "") -> None:
    repo = get_repo_state(state, repo_id)
    repo["manual_approval"] = {
        "status": "approved" if approved else "rejected",
        "approved_at": now_iso(),
        "notes": notes,
    }
    set_phase_status(
        state,
        repo_id,
        "harness_approval",
        "completed" if approved else "failed",
        error=None if approved else (notes or "rejected by reviewer"),
    )


def campaign_summary(state: dict[str, Any]) -> dict[str, Any]:
    totals: dict[str, int] = {status: 0 for status in PHASE_STATUS}
    by_phase: dict[str, dict[str, int]] = {phase: {s: 0 for s in PHASE_STATUS} for phase in PHASES}
    for repo in state.get("repos", {}).values():
        for phase, entry in repo.get("phases", {}).items():
            status = entry.get("status", "pending")
            totals[status] = totals.get(status, 0) + 1
            if phase in by_phase:
                by_phase[phase][status] = by_phase[phase].get(status, 0) + 1
    return {"totals": totals, "by_phase": by_phase}


def append_log(repo_id: str, phase: str, text: str) -> Path:
    path = log_path(repo_id, phase)
    ensure_dir(path.parent)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(text)
        if not text.endswith("\n"):
            handle.write("\n")
    return path


class LogWriter:
    """Mirror stdout/stderr to a phase log file."""

    def __init__(self, repo_id: str, phase: str):
        self.path = log_path(repo_id, phase)
        ensure_dir(self.path.parent)
        self._file = self.path.open("w", encoding="utf-8")

    def write(self, text: str) -> None:
        print(text, end="" if text.endswith("\n") else "\n", flush=True)
        self._file.write(text)
        if not text.endswith("\n"):
            self._file.write("\n")
        self._file.flush()

    def close(self) -> None:
        self._file.close()

    def __enter__(self) -> LogWriter:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def tail_log(path: Path, max_lines: int = 200) -> str:
    if not path.exists():
        return ""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(lines[-max_lines:])
