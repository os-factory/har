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


def save_har_cache(repo_slug: str, harness_root: Path, profile: str) -> Path:
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
        },
    )
    return dest_root
