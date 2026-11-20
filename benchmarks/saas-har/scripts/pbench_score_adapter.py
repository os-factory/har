#!/usr/bin/env python3
"""Run PrototypeBench's `harness.score.score_patch` from a spec file.

Executed inside the vendored PrototypeBench venv (`uv run --project .vendor/prototypebench`),
so the benchmark reuses the upstream scorer unchanged: test_patch is applied first, then the
agent patch, then pytest runs in the upstream Docker image and FAIL_TO_PASS / PASS_TO_PASS
membership decides the binary score.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--mode", default="docker")
    args = parser.parse_args()
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))

    from harness import score as sc
    from harness.sources import get as get_source

    source = get_source(spec["repo"])
    score_spec = sc.ScoreSpec(
        instance_id=spec["instance_id"],
        repo_url=source.repo_url,
        base_commit=spec["base_commit"],
        test_patch=spec["test_patch"],
        fail_to_pass=spec["fail_to_pass"],
        pass_to_pass=spec["pass_to_pass"],
        agent_patch=Path(spec["patch_file"]).read_text(encoding="utf-8"),
    )
    result = sc.score_patch(score_spec, source=source, work_root=Path(spec["work_root"]), mode=args.mode)
    data = dataclasses.asdict(result)
    data["n_fail_to_pass"] = len(spec["fail_to_pass"])
    data["n_pass_to_pass"] = len(spec["pass_to_pass"])
    Path(args.out).write_text(json.dumps(data, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps({"score": data.get("score"), "error": data.get("error")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
