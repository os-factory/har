"""Per-repository `.har/` harness cache for SWE-bench runs."""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from .common import BENCHMARK_ROOT, benchmark_config, now_iso, read_json, write_json

HAR_EPHEMERAL_SUBDIRS = frozenset({"slots", "runs", "logs", "artifacts"})


def repo_cache_slug(repo_slug: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", repo_slug)


def cache_root() -> Path:
    cfg = benchmark_config()
    return BENCHMARK_ROOT / cfg.get("har_cache_dir", ".har-cache")


def cache_dir_for_repo(repo_slug: str) -> Path:
    return cache_root() / repo_cache_slug(repo_slug)


def har_cache_meta(repo_slug: str) -> dict[str, Any] | None:
    meta_path = cache_dir_for_repo(repo_slug) / "meta.json"
    if not meta_path.exists():
        return None
    return read_json(meta_path)


def har_cache_exists(repo_slug: str, profile: str | None = None) -> bool:
    har_dir = cache_dir_for_repo(repo_slug) / ".har"
    if not (har_dir / "launch.sh").exists():
        return False
    if profile is None:
        return True
    meta = har_cache_meta(repo_slug)
    return meta is not None and meta.get("profile") == profile


def load_har_cache(repo_slug: str, harness_root: Path) -> bool:
    src = cache_dir_for_repo(repo_slug) / ".har"
    if not src.exists():
        return False
    dest = harness_root / ".har"
    if dest.exists():
        shutil.rmtree(dest)

    def _ignore_ephemeral(directory: str, names: list[str]) -> list[str]:
        del directory
        return [name for name in names if name in HAR_EPHEMERAL_SUBDIRS]

    shutil.copytree(src, dest, ignore=_ignore_ephemeral)
    return True


def invalidate_har_cache(repo_slug: str) -> bool:
    """Remove cached harness for a repo (e.g. after gate failure on a cache hit)."""
    cache_dir = cache_dir_for_repo(repo_slug)
    if not cache_dir.exists():
        return False
    shutil.rmtree(cache_dir)
    return True


def list_verification_stage_ids(harness_root: Path) -> list[str]:
    stages_path = harness_root / ".har" / "stages.json"
    if not stages_path.exists():
        return []
    data = read_json(stages_path)
    return [str(x) for x in (data.get("verificationStages") or [])]


def _stage_entries(data: dict[str, Any]) -> list[dict[str, Any]]:
    stages = data.get("stages")
    if isinstance(stages, dict):
        out: list[dict[str, Any]] = []
        for key, value in stages.items():
            if isinstance(value, dict):
                entry = dict(value)
                entry.setdefault("id", key)
                out.append(entry)
        return out
    if isinstance(stages, list):
        return [s for s in stages if isinstance(s, dict)]
    return []


def strip_verification_stages(harness_root: Path, keep_ids: set[str] | frozenset[str]) -> list[str]:
    """Remove verification stages (and scripts) not in keep_ids. Returns removed ids."""
    stages_path = harness_root / ".har" / "stages.json"
    if not stages_path.exists():
        return []
    data = read_json(stages_path)
    current = [str(x) for x in (data.get("verificationStages") or [])]
    removed = [sid for sid in current if sid not in keep_ids]
    if not removed:
        return []

    data["verificationStages"] = [sid for sid in current if sid in keep_ids]
    kept_entries: list[dict[str, Any]] = []
    har_root = (harness_root / ".har").resolve()
    for entry in _stage_entries(data):
        sid = str(entry.get("id") or "")
        if sid in removed:
            script = entry.get("script")
            if isinstance(script, str) and script:
                script_path = (harness_root / ".har" / script).resolve()
                if str(script_path).startswith(str(har_root)) and script_path.exists():
                    script_path.unlink()
            continue
        kept_entries.append(entry)
    data["stages"] = kept_entries
    write_json(stages_path, data)
    return removed


def save_har_cache(
    repo_slug: str,
    harness_root: Path,
    profile: str,
    *,
    keep_verification_stage_ids: set[str] | frozenset[str] | None = None,
) -> Path:
    """Persist repo-generic `.har/`. Optionally strip task-scoped verification stages first."""
    removed: list[str] = []
    if keep_verification_stage_ids is not None:
        removed = strip_verification_stages(harness_root, keep_verification_stage_ids)

    dest_root = cache_dir_for_repo(repo_slug)
    har_src = harness_root / ".har"
    har_dest = dest_root / ".har"
    if har_dest.exists():
        shutil.rmtree(har_dest)

    def _ignore_ephemeral(directory: str, names: list[str]) -> list[str]:
        del directory
        return [name for name in names if name in HAR_EPHEMERAL_SUBDIRS]

    shutil.copytree(har_src, har_dest, ignore=_ignore_ephemeral)
    write_json(
        dest_root / "meta.json",
        {
            "repo": repo_slug,
            "profile": profile,
            "adapted_at": now_iso(),
            "verification_stage_ids": list_verification_stage_ids(harness_root),
            "stripped_task_stages": removed,
        },
    )
    return dest_root
