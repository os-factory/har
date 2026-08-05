import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { buildAuthoringTools, handleAuthoringToolCall } from './tools';
import { info, success } from '../utils/logging';
import { getHarnessDir } from '../harness/manifest';
import { resolvePromptPath, resolveTemplateFile } from '../utils/paths';

export interface AuthoringOptions {
  verbose?: boolean;
  model?: string;
  mode?: 'init' | 'maintain';
}

export interface AuthoringResult {
  summary: string;
  stack?: {
    language?: string;
    packageManager?: string;
    database?: string;
  };
}

export async function authorHarness(
  repoPath: string,
  apiKey: string,
  options: AuthoringOptions = {},
): Promise<AuthoringResult> {
  const client = new Anthropic({ apiKey });
  const model = options.model ?? 'claude-sonnet-4-6';
  const harnessDir = getHarnessDir(repoPath);
  const mode = options.mode ?? 'init';

  const systemPromptPath = resolvePromptPath('system-authoring.md');
  const agentMdTemplatePath = resolveTemplateFile('AGENTS.md.template');
  let systemPrompt = fs.existsSync(systemPromptPath)
    ? fs.readFileSync(systemPromptPath, 'utf8')
    : 'Adapt the .har/ boilerplate to match the repository. Edit files directly. Call finishAuthoring when done.';

  if (agentMdTemplatePath) {
    systemPrompt += `\n\n## AGENTS.md template (starting point for proposeAgentsMd)\n\n${fs.readFileSync(agentMdTemplatePath, 'utf8')}`;
  }

  const tools = buildAuthoringTools();
  const messages: Anthropic.MessageParam[] = [];

  let rootListing: string;
  try {
    rootListing = fs.readdirSync(repoPath).slice(0, 50).join('\n');
  } catch {
    throw new Error(`Cannot read repo at path: ${repoPath}`);
  }

  let harnessListing: string;
  try {
    harnessListing = fs.readdirSync(harnessDir).join('\n');
  } catch {
    throw new Error(`Cannot read harness dir at: ${harnessDir}`);
  }

  const existingAgentMd = fs.existsSync(path.join(repoPath, 'AGENTS.md'))
    ? 'AGENTS.md exists at repo root — read it before proposing changes via proposeAgentsMd.'
    : 'No AGENTS.md at repo root yet — propose one via proposeAgentsMd.';

  const modeInstructions =
    mode === 'maintain'
      ? `This is a MAINTENANCE run. .har/ already exists and may have been edited by humans.
Update it to reflect current repo changes. Prefer editHarnessFile over writeHarnessFile.
Keep README.md accurate — it is the index of the harness. ${existingAgentMd}`
      : `This is an INITIAL setup. A fresh boilerplate has been copied to .har/.
Adapt all files to match this repository. Replace all TODO placeholders.
Write a clear README.md explaining what's in .har/. ${existingAgentMd}`;

  messages.push({
    role: 'user',
    content: `${modeInstructions}

Repository root contents:
${rootListing}

.har/ contents:
${harnessListing}

Start by reading key repo files to understand the stack, then read and adapt the harness files.`,
  });

  let finishedSummary: string | null = null;
  let finishedStack: AuthoringResult['stack'];

  const callbacks = {
    onFinish: (
      summary: string,
      stack?: { language?: string; packageManager?: string; database?: string },
    ) => {
      finishedSummary = summary;
      finishedStack = stack;
    },
  };

  let iterations = 0;
  const MAX_ITERATIONS = 40;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    if (options.verbose) {
      info(`Authoring iteration ${iterations}/${MAX_ITERATIONS}`);
    }

    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      tools,
      messages,
    });

    if (options.verbose) {
      info(`stop_reason: ${response.stop_reason}`);
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        const toolResult = await handleAuthoringToolCall(
          block.name,
          block.input as Record<string, unknown>,
          repoPath,
          harnessDir,
          callbacks,
        );

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: toolResult,
        });
      }

      messages.push({ role: 'user', content: toolResults });

      if (finishedSummary) break;
    }
  }

  if (!finishedSummary) {
    throw new Error(
      `Authoring agent did not finish after ${MAX_ITERATIONS} iterations.\n` +
        'Try running with --verbose to see what the agent is doing.',
    );
  }

  const result: AuthoringResult = { summary: finishedSummary, stack: finishedStack };
  success(result.summary);
  return result;
}
