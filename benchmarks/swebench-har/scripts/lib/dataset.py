"""SWE-bench dataset helpers."""

from __future__ import annotations

import random
from collections import defaultdict
from typing import Any

# SWE-bench / SWE-bench Lite repos are overwhelmingly Python today.
# Keep an explicit map so multi-language full SWE-bench stays correct if we expand.
_REPO_LANGUAGE: dict[str, str] = {
    "django/django": "python",
    "sympy/sympy": "python",
    "matplotlib/matplotlib": "python",
    "scikit-learn/scikit-learn": "python",
    "pytest-dev/pytest": "python",
    "sphinx-doc/sphinx": "python",
    "astropy/astropy": "python",
    "psf/requests": "python",
    "pylint-dev/pylint": "python",
    "pydata/xarray": "python",
    "mwaskom/seaborn": "python",
    "pallets/flask": "python",
    # Common full SWE-bench non-Python examples (for future splits)
    "npm/cli": "javascript",
    "prettier/prettier": "javascript",
    "alibaba/fastjson": "java",
    "google/gson": "java",
}


def infer_language(row: dict[str, Any]) -> str:
    """Return a coarse language label for diversity sampling."""
    if row.get("language"):
        return str(row["language"]).strip().lower()
    repo = str(row.get("repo") or "")
    if repo in _REPO_LANGUAGE:
        return _REPO_LANGUAGE[repo]
    # Heuristic fallbacks from repo slug
    lower = repo.lower()
    if any(tok in lower for tok in ("java", "spring", "jackson", "gson")):
        return "java"
    if any(tok in lower for tok in ("npm", "node", "react", "vue", "prettier", "eslint")):
        return "javascript"
    if any(tok in lower for tok in ("rust", "tokio")):
        return "rust"
    if any(tok in lower for tok in ("go-", "/go", "golang")):
        return "go"
    return "python"


def load_split(dataset_name: str, split: str) -> list[dict[str, Any]]:
    from datasets import load_dataset

    dataset = load_dataset(dataset_name, split=split)
    return [dict(row) for row in dataset]


def pick_row(rows: list[dict[str, Any]], seed: int | None, instance_id: str | None) -> dict[str, Any]:
    if instance_id:
        for row in rows:
            if row["instance_id"] == instance_id:
                return row
        raise ValueError(f"instance_id not found: {instance_id}")
    if seed is not None:
        random.seed(seed)
    return random.choice(rows)


def sample_rows(
    rows: list[dict[str, Any]],
    count: int,
    seed: int | None = None,
    *,
    max_per_repo: int | None = None,
    max_repos_per_language: int | None = None,
) -> list[dict[str, Any]]:
    """Sample instances, optionally capping per-repo and per-language repo fan-out.

    When diversity caps are unset, behaves as uniform ``random.sample``.
    With caps:
      - at most ``max_repos_per_language`` distinct repos per language
      - at most ``max_per_repo`` instances per repo
      - repos within a language are preferred by size (seeded tie-break) so a
        target ``count`` remains achievable on skewed datasets like SWE-bench Lite
    """
    if count < 1:
        raise ValueError("count must be >= 1")
    if count > len(rows):
        raise ValueError(f"count {count} exceeds dataset size {len(rows)}")

    if max_per_repo is None and max_repos_per_language is None:
        rng = random.Random(seed)
        return rng.sample(rows, count)

    return sample_rows_diverse(
        rows,
        count,
        seed=seed,
        max_per_repo=max_per_repo if max_per_repo is not None else count,
        max_repos_per_language=(
            max_repos_per_language if max_repos_per_language is not None else count
        ),
    )


def sample_rows_diverse(
    rows: list[dict[str, Any]],
    count: int,
    *,
    seed: int | None = None,
    max_per_repo: int = 5,
    max_repos_per_language: int = 10,
) -> list[dict[str, Any]]:
    if max_per_repo < 1:
        raise ValueError("max_per_repo must be >= 1")
    if max_repos_per_language < 1:
        raise ValueError("max_repos_per_language must be >= 1")

    rng = random.Random(seed)

    by_lang_repo: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for row in rows:
        lang = infer_language(row)
        by_lang_repo[lang][str(row["repo"])].append(row)

    pool: list[dict[str, Any]] = []
    selection_meta: dict[str, Any] = {"languages": {}, "constraints": {
        "max_per_repo": max_per_repo,
        "max_repos_per_language": max_repos_per_language,
        "count": count,
        "seed": seed,
    }}

    for lang in sorted(by_lang_repo.keys()):
        repos = by_lang_repo[lang]
        # Prefer larger repos so count remains fillable; seeded shuffle breaks ties.
        ranked = sorted(
            repos.keys(),
            key=lambda repo: (-len(repos[repo]), rng.random()),
        )
        chosen_repos = ranked[:max_repos_per_language]
        lang_picked = 0
        for repo in chosen_repos:
            items = list(repos[repo])
            rng.shuffle(items)
            take = items[: min(max_per_repo, len(items))]
            pool.extend(take)
            lang_picked += len(take)
        selection_meta["languages"][lang] = {
            "repos_available": len(repos),
            "repos_selected": chosen_repos,
            "instances_selected": lang_picked,
        }

    if len(pool) < count:
        raise ValueError(
            f"diversity constraints yield only {len(pool)} instances "
            f"(need {count}); relax max_per_repo / max_repos_per_language "
            f"or lower count. meta={selection_meta}"
        )

    selected = rng.sample(pool, count) if len(pool) > count else list(pool)
    # Stable-ish print order: shuffle once more for run order diversity
    rng.shuffle(selected)
    # Attach sampling meta on a side channel via function attribute for callers/tests
    sample_rows_diverse.last_meta = selection_meta  # type: ignore[attr-defined]
    sample_rows_diverse.last_meta["pool_size"] = len(pool)  # type: ignore[attr-defined]
    sample_rows_diverse.last_meta["returned"] = len(selected)  # type: ignore[attr-defined]
    return selected
