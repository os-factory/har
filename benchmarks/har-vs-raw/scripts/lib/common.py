"""Shared utilities for the HAR vs raw benchmark."""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

BENCHMARK_ROOT = Path(__file__).resolve().parents[2]
HAR_PROJECT_ROOT = BENCHMARK_ROOT.parents[1]
NODE_MODULES = HAR_PROJECT_ROOT / "node_modules"


def load_yaml(path: Path) -> Any:
    """Load YAML via the repo's js-yaml dependency."""
    script = """
const yaml = require('js-yaml');
const fs = require('fs');
const target = process.argv[1];
console.log(JSON.stringify(yaml.load(fs.readFileSync(target, 'utf8'))));
"""
    result = subprocess.run(
        ["node", "-e", script, str(path)],
        cwd=HAR_PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to load YAML {path}: {result.stderr.strip()}")
    return json.loads(result.stdout)


def dump_yaml(path: Path, data: Any) -> None:
    script = """
const yaml = require('js-yaml');
const fs = require('fs');
const target = process.argv[1];
fs.writeFileSync(target, yaml.dump(JSON.parse(process.argv[2]), { lineWidth: 120 }));
"""
    subprocess.run(
        ["node", "-e", script, str(path), json.dumps(data)],
        cwd=HAR_PROJECT_ROOT,
        check=True,
    )


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


def merge_env(*sources: dict[str, str]) -> dict[str, str]:
    merged: dict[str, str] = {}
    for source in sources:
        merged.update(source)
    return merged


def github_request(
    path: str,
    token: str | None = None,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> Any:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "har-vs-raw-benchmark",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"https://api.github.com{path}", headers=headers, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API error {exc.code} for {path}: {body_text}") from exc


def github_search_issues(owner: str, repo: str, query: str, token: str | None = None) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "q": f"repo:{owner}/{repo} is:issue is:closed {query}",
            "sort": "updated",
            "order": "desc",
            "per_page": "30",
        }
    )
    data = github_request(f"/search/issues?{params}", token=token)
    return data.get("items", [])


def github_issue_timeline(owner: str, repo: str, issue_number: int, token: str | None = None) -> list[dict[str, Any]]:
    return github_request(f"/repos/{owner}/{repo}/issues/{issue_number}/timeline", token=token)


def github_pull(owner: str, repo: str, pull_number: int, token: str | None = None) -> dict[str, Any]:
    return github_request(f"/repos/{owner}/{repo}/pulls/{pull_number}", token=token)


def github_pull_files(owner: str, repo: str, pull_number: int, token: str | None = None) -> list[str]:
    return [item["filename"] for item in github_pull_file_details(owner, repo, pull_number, token=token)]


def github_pull_file_details(
    owner: str, repo: str, pull_number: int, token: str | None = None
) -> list[dict[str, Any]]:
    files = github_request(f"/repos/{owner}/{repo}/pulls/{pull_number}/files?per_page=100", token=token)
    return [
        {
            "filename": item.get("filename", ""),
            "status": item.get("status", ""),
            "additions": int(item.get("additions") or 0),
            "changes": int(item.get("changes") or 0),
        }
        for item in files
        if item.get("filename")
    ]


def github_compare(owner: str, repo: str, base: str, head: str, token: str | None = None) -> dict[str, Any]:
    return github_request(f"/repos/{owner}/{repo}/compare/{base}...{head}", token=token)


def find_closing_pull(owner: str, repo: str, issue_number: int, token: str | None = None) -> dict[str, Any] | None:
    timeline = github_issue_timeline(owner, repo, issue_number, token=token)
    for event in timeline:
        if event.get("event") != "cross-referenced":
            continue
        source = event.get("source") or {}
        issue = source.get("issue") or {}
        if not issue.get("pull_request"):
            continue
        pull_number = issue.get("number")
        if not pull_number:
            continue
        pull = github_pull(owner, repo, pull_number, token=token)
        if pull.get("merged_at"):
            return pull
    params = urllib.parse.urlencode(
        {
            "q": f"repo:{owner}/{repo} is:pr is:merged {issue_number} in:body sort:updated-desc",
            "per_page": "10",
        }
    )
    for item in github_request(f"/search/issues?{params}", token=token).get("items", []):
        pull_number = item.get("number")
        if not pull_number:
            continue
        pull = github_pull(owner, repo, pull_number, token=token)
        body = (pull.get("body") or "").lower()
        title = (pull.get("title") or "").lower()
        needle = f"#{issue_number}"
        if pull.get("merged_at") and (needle in body or needle in title or f"fixes {issue_number}" in body):
            return pull
    return None


def base_commit_before_merge(owner: str, repo: str, pull: dict[str, Any], token: str | None = None) -> str | None:
    base_branch = pull.get("base", {}).get("ref")
    merge_commit = pull.get("merge_commit_sha")
    if not base_branch or not merge_commit:
        return None
    compare = github_compare(owner, repo, base_branch, merge_commit, token=token)
    if compare.get("status") == "identical":
        return merge_commit
    commits = compare.get("commits") or []
    if not commits:
        return pull.get("base", {}).get("sha")
    return commits[0].get("parents", [{}])[0].get("sha") or commits[0].get("sha")


def is_frontend_issue(issue: dict[str, Any]) -> bool:
    text = " ".join(
        [
            issue.get("title") or "",
            issue.get("body") or "",
            " ".join(label.get("name", "") for label in issue.get("labels", [])),
        ]
    ).lower()
    frontend_terms = (
        "frontend",
        "ui",
        "ux",
        "browser",
        "react",
        "vue",
        "css",
        "dashboard",
        "web",
        "page",
        "modal",
        "button",
        "toggle",
        "chart",
        "table",
        "routing",
        "blank page",
        "render",
        "playwright",
        "e2e",
    )
    backend_only = (
        "migration",
        "database",
        "postgres",
        "redis",
        "infra",
        "docker",
        "kubernetes",
        "backend-only",
        "api-only",
        "s3",
        "irsa",
        "duckdb",
    )
    if any(term in text for term in backend_only):
        return False
    return any(term in text for term in frontend_terms)


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
            f"Command failed ({result.returncode}): {' '.join(cmd)}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def resolve_base_commit_before_date(repo_url: str, iso_date: str, branch: str = "main") -> str:
    """Approximate replay base commit as the last commit on branch before issue close."""
    cache_root = BENCHMARK_ROOT / ".repo-cache"
    ensure_dir(cache_root)
    repo_key = slugify(repo_url.replace("https://github.com/", "").replace(".git", ""))
    tmp = cache_root / repo_key
    if not tmp.exists():
        run_command(["git", "clone", "--quiet", "--branch", branch, "--single-branch", repo_url, str(tmp)], check=True)
    else:
        run_command(["git", "fetch", "--quiet", "origin", branch], cwd=tmp, check=False)
    result = run_command(["git", "rev-list", "-1", f"--before={iso_date}", f"origin/{branch}"], cwd=tmp, check=True)
    sha = result.stdout.strip()
    if not sha:
        result = run_command(["git", "rev-list", "-1", f"--before={iso_date}", branch], cwd=tmp, check=True)
        sha = result.stdout.strip()
    if not sha:
        raise RuntimeError(f"No commit found before {iso_date} on {branch}")
    return sha


def slugify(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def langfuse_auth_header(public_key: str, secret_key: str) -> str:
    token = base64.b64encode(f"{public_key}:{secret_key}".encode("utf-8")).decode("ascii")
    return f"Authorization=Basic {token},x-langfuse-ingestion-version=4"


def langfuse_request(
    method: str,
    path: str,
    *,
    host: str,
    public_key: str,
    secret_key: str,
    payload: dict[str, Any] | None = None,
) -> Any:
    url = f"{host.rstrip('/')}{path}"
    data = None
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Basic {base64.b64encode(f'{public_key}:{secret_key}'.encode()).decode()}",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Langfuse API error {exc.code} for {path}: {body}") from exc


def load_benchmark_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update(load_env_file(BENCHMARK_ROOT / ".env.local"))
    return env


def benchmark_config() -> dict[str, Any]:
    return load_yaml(BENCHMARK_ROOT / "config.yaml")


def campaign_config(campaign: str = "default") -> dict[str, Any]:
    if campaign == "v3":
        return load_yaml(BENCHMARK_ROOT / "config.v3.yaml")
    return benchmark_config()


def benchmark_repos() -> list[dict[str, Any]]:
    return load_yaml(BENCHMARK_ROOT / "repos.yaml")["repos"]


def campaign_repos(campaign: str = "default") -> list[dict[str, Any]]:
    if campaign == "v3":
        return load_yaml(BENCHMARK_ROOT / "repos.v3.yaml")["repos"]
    return benchmark_repos()


def benchmark_issues() -> list[dict[str, Any]]:
    path = BENCHMARK_ROOT / "issues.yaml"
    if not path.exists():
        return []
    data = load_yaml(path)
    return data.get("issues", [])


def campaign_issues(campaign: str = "default") -> list[dict[str, Any]]:
    if campaign == "v3":
        path = BENCHMARK_ROOT / "issues.v3.yaml"
    else:
        path = BENCHMARK_ROOT / "issues.yaml"
    if not path.exists():
        return []
    data = load_yaml(path)
    return data.get("issues", [])


def resolve_repo_list(campaign: str, repo_filter: str | None = None) -> list[dict[str, Any]]:
    repos = campaign_repos(campaign)
    if repo_filter:
        repos = [r for r in repos if r["id"] == repo_filter or f"{r['owner']}/{r['name']}" == repo_filter]
    return repos


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


REJECT_ISSUE_TERMS = (
    "performance",
    "500+",
    "cloudflare",
    "investigate",
    "oauth prod",
    "websocket prod",
    "hang:",
    "quota",
    "service account",
)

TEST_FILE_RE = re.compile(
    r"(\.test\.|\.spec\.|/e2e/|/cypress/|/playwright/|__tests__/)",
    re.IGNORECASE,
)


def is_test_file(path: str) -> bool:
    return bool(TEST_FILE_RE.search(path))


def is_reproducible_issue(issue: dict[str, Any]) -> bool:
    text = " ".join([issue.get("title") or "", issue.get("body") or ""]).lower()
    return not any(term in text for term in REJECT_ISSUE_TERMS)


def frontend_path_prefixes(repo: dict[str, Any]) -> list[str]:
    primary = (repo.get("primary_app") or "").strip("./")
    prefixes = []
    if primary:
        prefixes.append(primary if primary.endswith("/") else f"{primary}/")
    prefixes.extend(["frontend/", "packages/frontend/", "apps/web/", "webapp/", "static/app/", "app/client/"])
    return prefixes


def frontend_file_ratio(files: list[str], repo: dict[str, Any]) -> float:
    if not files:
        return 0.0
    prefixes = frontend_path_prefixes(repo)
    frontend_count = sum(1 for path in files if any(path.startswith(prefix) or f"/{prefix}" in path for prefix in prefixes))
    test_count = sum(1 for path in files if is_test_file(path))
    relevant = max(frontend_count, test_count)
    return relevant / len(files)


def pr_within_scope(file_details: list[dict[str, Any]], max_files: int = 15, max_lines: int = 400) -> bool:
    if len(file_details) > max_files:
        return False
    total = sum(item.get("changes", 0) for item in file_details)
    return total <= max_lines


def extract_test_files_from_pr(file_details: list[dict[str, Any]]) -> list[str]:
    added_or_modified = [
        item["filename"]
        for item in file_details
        if is_test_file(item["filename"]) and item.get("status") in {"added", "modified", "changed"}
    ]
    if added_or_modified:
        return added_or_modified
    return [item["filename"] for item in file_details if is_test_file(item["filename"])]


def infer_oracle_command(repo: dict[str, Any], test_files: list[str]) -> list[str] | None:
    if not test_files:
        return None
    target = test_files[0]
    pm = repo.get("package_manager", "npm")
    if pm == "pnpm":
        if target.startswith("packages/"):
            package = target.split("/")[1]
            return ["pnpm", "--filter", package, "test", target.split("/", 2)[-1] if "/" in target else target]
        return ["pnpm", "test", "--", target]
    if pm == "yarn":
        return ["yarn", "test", target]
    return ["npm", "test", "--", target]


def build_verification_block(repo: dict[str, Any], test_files: list[str]) -> dict[str, Any] | None:
    command = infer_oracle_command(repo, test_files)
    if not command:
        return None
    return {
        "primary": {"type": "test_command", "command": command, "cwd": None},
        "secondary_har": {"type": "har_verify_full"},
    }


def run_oracle(issue: dict[str, Any], repo_path: Path) -> dict[str, Any]:
    verification = issue.get("verification") or {}
    primary = verification.get("primary") or {}
    if primary.get("type") == "har_verify_full":
        return {"passed": True, "details": "har_verify_full (checked in external_verify for HAR arm)", "stdout": "", "stderr": ""}
    command = primary.get("command")
    if not command:
        return {"passed": False, "details": "no oracle command configured", "stdout": "", "stderr": ""}
    cwd = primary.get("cwd")
    workdir = repo_path if not cwd else repo_path / cwd
    result = run_command([str(part) for part in command], cwd=workdir)
    return {
        "passed": result.returncode == 0,
        "details": " ".join(command),
        "stdout": result.stdout[-6000:],
        "stderr": result.stderr[-6000:],
        "exit_code": result.returncode,
    }


def changed_files_in_repo(repo_path: Path) -> list[str]:
    names: set[str] = set()
    for args in (["git", "diff", "--name-only"], ["git", "diff", "--cached", "--name-only"], ["git", "diff", "HEAD", "--name-only"]):
        result = run_command(args, cwd=repo_path)
        for line in result.stdout.splitlines():
            line = line.strip()
            if line:
                names.add(line)
    return sorted(names)


def patch_overlap(changed: list[str], reference_files: list[str]) -> float:
    if not reference_files:
        return 0.0
    changed_set = set(changed)
    ref_set = set(reference_files)
    if not changed_set or not ref_set:
        return 0.0
    return len(changed_set & ref_set) / len(ref_set)


def read_har_slot_workdir(harness_root: Path, agent_id: int = 1) -> Path | None:
    slot_path = harness_root / ".har" / "slots" / f"agent-{agent_id}.json"
    if not slot_path.exists():
        return None
    data = read_json(slot_path)
    work_dir = data.get("workDir") or data.get("work_dir") or data.get("worktreePath")
    if work_dir:
        return Path(work_dir)
    return None


def har_launch_slot(harness_root: Path, agent_id: int = 1, timeout_seconds: int = 3600) -> tuple[bool, Path | None, str]:
    result = run_command(
        ["har", "env", "launch", str(agent_id), "--force"],
        cwd=harness_root,
        timeout=timeout_seconds,
    )
    if result.returncode != 0:
        return False, None, result.stderr or result.stdout
    workdir = read_har_slot_workdir(harness_root, agent_id)
    if workdir and workdir.exists():
        return True, workdir, result.stdout
    combined = f"{result.stdout}\n{result.stderr}"
    match = re.search(r"WORK DIR.*?(\/[^\s]+)", combined, re.IGNORECASE)
    if match:
        path = Path(match.group(1))
        if path.exists():
            return True, path, combined
    return False, None, combined


def har_teardown_slot(harness_root: Path, agent_id: int = 1) -> None:
    run_command(["har", "env", "teardown", str(agent_id)], cwd=harness_root)


def har_verify_full(harness_root: Path, agent_id: int = 1) -> dict[str, Any]:
    result = run_command(["har", "env", "verify", str(agent_id), "--full"], cwd=harness_root)
    return {
        "verified": result.returncode == 0,
        "details": f"har env verify {agent_id} --full",
        "stdout": result.stdout[-6000:],
        "stderr": result.stderr[-6000:],
        "exit_code": result.returncode,
    }


def load_harness_gate() -> dict[str, Any]:
    path = BENCHMARK_ROOT / "results" / "harness-gate.json"
    if not path.exists():
        return {"repos": {}}
    return read_json(path)


def repo_passes_harness_gate(repo_id: str) -> bool:
    gate = load_harness_gate()
    entry = gate.get("repos", {}).get(repo_id)
    return bool(entry and entry.get("passed"))


def repo_id_for_slug(repo_slug: str) -> str | None:
    for repo in benchmark_repos():
        if f"{repo['owner']}/{repo['name']}" == repo_slug:
            return repo["id"]
    return repo_slug.split("/")[-1]
