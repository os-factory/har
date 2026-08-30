# Occupancy lab (#316 station S3).
#
# Host-independent proof that two occupancies of the same slot stay distinct.
# The point of the container is an isolated HOME: on a laptop, Claude Code
# transcripts under ~/.claude/projects/<encoded-cwd> survive teardown and the
# harvest can re-attach them to the next occupancy of the same slot. A sandbox
# HOME makes that contamination impossible, so a green lab means the invariant
# holds — not that the developer's machine happened to be clean.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Isolated HOME — nothing from the host's ~/.claude is reachable.
ENV HOME=/lab/home \
    LAB_ROOT=/lab \
    GIT_AUTHOR_NAME=lab \
    GIT_AUTHOR_EMAIL=lab@example.invalid \
    GIT_COMMITTER_NAME=lab \
    GIT_COMMITTER_EMAIL=lab@example.invalid

RUN mkdir -p /lab/home /lab/work \
 && git config --global user.name lab \
 && git config --global user.email lab@example.invalid \
 && git config --global init.defaultBranch main

WORKDIR /lab
ENTRYPOINT ["node", "/lab/repo/.har/lines/occupancy-identity/lab/run-lab.mjs"]
