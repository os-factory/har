#!/usr/bin/env python3
"""Re-score saved patches of an existing run (after a scorer fix) and update run.json + results.jsonl."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT, append_jsonl, benchmark_config, log_event, read_json, write_json  # noqa: E402
from lib.datasets import find_instance  # noqa: E402
from run_instance import result_row, score_arm  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--arms", nargs="*", default=["har", "raw"])
    args = parser.parse_args()
    cfg = benchmark_config()
    run_dir = BENCHMARK_ROOT / cfg.get("runs_dir", "runs") / args.run_id
    record = read_json(run_dir / "run.json")
    instance = find_instance(record["dataset"], record["instance_id"])
    for arm in args.arms:
        if (run_dir / "predictions" / f"{arm}.patch").exists() and (record["arms"].get(arm) or {}).get("status") == "completed":
            record.setdefault("scores", {})[arm] = score_arm(instance, run_dir, arm, cfg, record["run_id"] + "-rescore")
            write_json(run_dir / "run.json", record)
            append_jsonl(BENCHMARK_ROOT / cfg.get("results_dir", "results") / "results.jsonl", result_row(instance, record, arm))
    log_event("rescore.done", run_id=args.run_id, scores={a: s.get("resolved") for a, s in record.get("scores", {}).items()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
