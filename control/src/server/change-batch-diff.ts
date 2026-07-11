import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { prisma } from '@/lib/db';

const execFileAsync = promisify(execFile);
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/i;
const MAX_DIFF_BYTES = 1_000_000;

function diffDirectory(repoPath: string, workDir: string | null): string {
  if (workDir && fs.existsSync(workDir)) return workDir;
  return repoPath;
}

export async function getChangeBatchDiff(repositoryId: string, batchId: string) {
  const batch = await prisma.changeBatch.findFirst({
    where: { id: batchId, repositoryId },
    include: { repository: { select: { path: true } } },
  });
  if (!batch) return undefined;

  if (!batch.headSha || !GIT_OBJECT_ID.test(batch.headSha) || !GIT_OBJECT_ID.test(batch.treeHash)) {
    throw new Error('This change batch does not have a diffable Git snapshot.');
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        'diff',
        '--no-ext-diff',
        '--find-renames',
        '--find-copies',
        '--unified=3',
        batch.headSha,
        batch.treeHash,
        '--',
      ],
      {
        cwd: diffDirectory(batch.repository.path, batch.workDir),
        maxBuffer: MAX_DIFF_BYTES,
        encoding: 'utf8',
      },
    );
    return { diff: stdout, truncated: false };
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        diff: '',
        truncated: true,
      };
    }
    throw new Error('The Git objects for this change batch are no longer available.');
  }
}
