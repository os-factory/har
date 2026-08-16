#!/usr/bin/env node
/**
 * Seed demo worktree rows for Mission Control cleanup screenshots.
 * Usage: DATABASE_URL=file:./prisma/agent_1.db node scripts/seed-worktrees-demo.mjs
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  await prisma.agentSlot.deleteMany();
  await prisma.repository.deleteMany();

  const harPortal = await prisma.repository.create({
    data: {
      path: '/home/dev/kerno/har-portal',
      gitRemote: 'https://github.com/os-factory/har-portal.git',
    },
  });
  const aicore = await prisma.repository.create({
    data: {
      path: '/home/dev/kerno/aicore',
      gitRemote: 'git@github.com:kernoio/aicore.git',
    },
  });

  const stale = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000);
  const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  await prisma.agentSlot.createMany({
    data: [
      {
        repositoryId: harPortal.id,
        slotId: 1,
        active: true,
        worktreePath: '/home/dev/worktrees/onboarding-har-agent-1-nvjg',
        branch: 'cursor/onboarding-session',
        harnessUsage: 'mcp',
        sessionCreatedAt: stale,
        dirty: false,
        purpose: 'Onboarding paywall fix (merged)',
      },
      {
        repositoryId: harPortal.id,
        slotId: 4,
        active: true,
        worktreePath: '/home/antoine/worktrees/main-3c05-har-agent-4-c8m4',
        branch: 'feat/har-cloud-poc-v1',
        harnessUsage: 'cli',
        sessionCreatedAt: recent,
        dirty: false,
        purpose: 'HAR Cloud POC',
      },
      {
        repositoryId: aicore.id,
        slotId: 2,
        active: true,
        worktreePath: '/home/antoine/worktrees/main-7db2-har-agent-2-1wrs',
        branch: 'ci-preserve-latest-dev-runtimes',
        harnessUsage: 'cli',
        sessionCreatedAt: stale,
        dirty: false,
      },
      {
        repositoryId: aicore.id,
        slotId: 3,
        active: true,
        worktreePath: '/home/antoine/worktrees/main-7db2-har-agent-2-1wrs/control',
        branch: 'main-b34e2-har-agent-3-7nox',
        harnessUsage: 'mcp',
        sessionCreatedAt: recent,
        dirty: true,
        purpose: 'Langfuse env cleanup',
      },
      {
        repositoryId: aicore.id,
        slotId: 5,
        active: false,
        worktreePath: '/home/dev/worktrees/missing-har-agent-5-dead',
        branch: 'old-session-branch',
        harnessUsage: 'none',
        sessionCreatedAt: stale,
        dirty: false,
      },
    ],
  });

  process.stdout.write('Seeded demo worktrees for Mission Control cleanup UI\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
