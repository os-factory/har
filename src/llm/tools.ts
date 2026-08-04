import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, listDir, writeFileSafe, resolveSafePath } from '../utils/file-ops';
import { info } from '../utils/logging';
import { writeAgentMdProposal } from '../harness/agent-md';

export interface AuthoringCallbacks {
  onFinish: (_summary: string, _stack?: { language?: string; packageManager?: string; database?: string }) => void;
}

export function buildAuthoringTools(): Anthropic.Tool[] {
  return [
    {
      name: 'readRepoFile',
      description: 'Read a file from the target repository root.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path from repo root' },
          maxChars: { type: 'number', description: 'Max characters (default 8000)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'listRepoDir',
      description: 'List files in the target repository.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path (use "." for root)' },
          maxFiles: { type: 'number' },
        },
        required: ['path'],
      },
    },
    {
      name: 'readHarnessFile',
      description: 'Read a file from the .har/ harness directory.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path within .har/' },
          maxChars: { type: 'number' },
        },
        required: ['path'],
      },
    },
    {
      name: 'listHarnessDir',
      description: 'List files in the .har/ harness directory.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path within .har/' },
        },
        required: ['path'],
      },
    },
    {
      name: 'writeHarnessFile',
      description: 'Write or overwrite a file in .har/. Use for full file rewrites.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path within .har/' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'editHarnessFile',
      description: 'Replace a unique string in a .har/ file. old_string must appear exactly once.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path within .har/' },
          old_string: { type: 'string', description: 'Exact text to replace (must be unique)' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'deleteHarnessFile',
      description: 'Delete a file from .har/. Use sparingly — prefer editing.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Relative path within .har/' },
        },
        required: ['path'],
      },
    },
    {
      name: 'proposeAgentsMd',
      description:
        'Propose content for AGENTS.md at the repo root. Does NOT write the file — the user approves after init/maintain. Include project-specific notes and pointer to .har/.',
      input_schema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'Full proposed AGENTS.md content' },
          rationale: { type: 'string', description: 'Why these changes (shown to user)' },
        },
        required: ['content', 'rationale'],
      },
    },
    {
      name: 'ask',
      description: 'Ask the user when something is genuinely ambiguous.',
      input_schema: {
        type: 'object' as const,
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['question'],
      },
    },
    {
      name: 'finishAuthoring',
      description:
        'Call when harness adaptation is complete. Provide a summary of changes and detected stack.',
      input_schema: {
        type: 'object' as const,
        properties: {
          summary: { type: 'string', description: 'One-paragraph summary of adaptations made' },
          language: { type: 'string' },
          packageManager: { type: 'string' },
          database: { type: 'string' },
        },
        required: ['summary'],
      },
    },
  ];
}

export async function handleAuthoringToolCall(
  toolName: string,
  input: Record<string, unknown>,
  repoPath: string,
  harnessDir: string,
  callbacks: AuthoringCallbacks,
): Promise<string> {
  try {
    return await executeAuthoringToolCall(toolName, input, repoPath, harnessDir, callbacks);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

async function executeAuthoringToolCall(
  toolName: string,
  input: Record<string, unknown>,
  repoPath: string,
  harnessDir: string,
  callbacks: AuthoringCallbacks,
): Promise<string> {
  switch (toolName) {
    case 'readRepoFile': {
      const filePath = path.join(repoPath, input.path as string);
      const content = readFile(filePath, (input.maxChars as number) ?? 8000);
      info(`Read repo: ${input.path}`);
      return content;
    }

    case 'listRepoDir': {
      const dirPath = path.join(repoPath, (input.path as string) ?? '.');
      const entries = listDir(dirPath, (input.maxFiles as number) ?? 60);
      info(`List repo: ${input.path} → ${entries.length} entries`);
      return entries.length > 0 ? entries.join('\n') : '(empty directory)';
    }

    case 'readHarnessFile': {
      const filePath = resolveSafePath(harnessDir, input.path as string);
      const content = readFile(filePath, (input.maxChars as number) ?? 12000);
      info(`Read harness: ${input.path}`);
      return content;
    }

    case 'listHarnessDir': {
      const dirPath = resolveSafePath(harnessDir, (input.path as string) ?? '.');
      const entries = listDir(dirPath, 60);
      info(`List harness: ${input.path} → ${entries.length} entries`);
      return entries.length > 0 ? entries.join('\n') : '(empty directory)';
    }

    case 'writeHarnessFile': {
      const relPath = input.path as string;
      if (relPath === 'manifest.json') {
        return 'Error: manifest.json is managed by har — do not edit directly';
      }
      const filePath = resolveSafePath(harnessDir, relPath);
      writeFileSafe(filePath, input.content as string);
      if (relPath.endsWith('.sh')) {
        fs.chmodSync(filePath, 0o755);
      }
      info(`Wrote harness: ${relPath}`);
      return `Written ${relPath} (${(input.content as string).length} bytes)`;
    }

    case 'editHarnessFile': {
      const filePath = resolveSafePath(harnessDir, input.path as string);
      if (!fs.existsSync(filePath)) {
        return `Error: file not found: ${input.path}`;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      const oldStr = input.old_string as string;
      const newStr = input.new_string as string;
      const count = content.split(oldStr).length - 1;
      if (count === 0) {
        return `Error: old_string not found in ${input.path}`;
      }
      if (count > 1) {
        return `Error: old_string appears ${count} times in ${input.path} — must be unique`;
      }
      const updated = content.replace(oldStr, newStr);
      writeFileSafe(filePath, updated);
      info(`Edited harness: ${input.path}`);
      return `Edited ${input.path}`;
    }

    case 'deleteHarnessFile': {
      const filePath = resolveSafePath(harnessDir, input.path as string);
      if (!fs.existsSync(filePath)) {
        return `File not found (already deleted): ${input.path}`;
      }
      fs.unlinkSync(filePath);
      info(`Deleted harness: ${input.path}`);
      return `Deleted ${input.path}`;
    }

    case 'proposeAgentsMd': {
      writeAgentMdProposal(repoPath, input.content as string, input.rationale as string);
      info('Proposed AGENTS.md (awaiting user approval)');
      return 'AGENTS.md proposal saved to .har/AGENTS.md.proposed — user will be prompted to apply.';
    }

    case 'ask': {
      return askUser(input.question as string, (input.options as string[]) ?? []);
    }

    case 'finishAuthoring': {
      const stack =
        input.language || input.packageManager || input.database
          ? {
              language: input.language as string | undefined,
              packageManager: input.packageManager as string | undefined,
              database: input.database as string | undefined,
            }
          : undefined;
      callbacks.onFinish(input.summary as string, stack);
      return 'Harness authoring recorded successfully.';
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

async function askUser(question: string, options: string[]): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  return new Promise((resolve) => {
    process.stderr.write('\n');
    process.stderr.write(`❓ ${question}\n`);
    if (options.length > 0) {
      options.forEach((opt, i) => process.stderr.write(`  ${i + 1}. ${opt}\n`));
    }
    process.stderr.write('> ');
    rl.once('line', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
