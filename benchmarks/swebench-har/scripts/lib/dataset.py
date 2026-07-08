"""SWE-bench dataset helpers."""

from __future__ import annotations

import random
from typing import Any


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
