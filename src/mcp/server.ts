import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { describeProject, initHarness } from '../core/harness';
import {
  completeEnvironment,
  getEnvironmentLogs,
  getEnvironmentStatus,
  launchEnvironment,
  listArtifacts,
  runStage,
  runVerification,
  teardownEnvironment,
} from '../core/run-service';
import { getRun, listRuns } from '../core/runs';
import {
  agentIdJsonProperty,
  objectJsonSchema,
  repoJsonProperty,
  stageKindJsonProperty,
} from './schema-tools';
import { validateAgentId } from '../utils/validation';
import {
  CompleteEnvironmentInputSchema,
  CompleteEnvironmentOutputSchema,
  DescribeProjectOutputSchema,
  EnvironmentRunOutputSchema,
  GetLogsInputSchema,
  TeardownEnvironmentInputSchema,
  InitHarnessInputSchema,
  LaunchEnvironmentInputSchema,
  LaunchEnvironmentOutputSchema,
  ListArtifactsInputSchema,
  ListArtifactsOutputSchema,
  ListRunsInputSchema,
  ListRunsOutputSchema,
  GetRunInputSchema,
  GetRunOutputSchema,
  RunStageInputSchema,
  RunVerificationInputSchema,
  RunVerificationOutputSchema,
  StageResultSchema,
} from './schemas';

export const HAR_MCP_TOOLS: Tool[] = [
  {
    name: 'har_describe_project',
    description: 'Read manifest, stack hints, available scripts, and harness stages for a repository.',
    inputSchema: objectJsonSchema({ repo: repoJsonProperty }),
  },
  {
    name: 'har_init_harness',
    description: 'Scaffold .har/ boilerplate. Use auto=true for built-in Claude adaptation.',
    inputSchema: objectJsonSchema({
      repo: repoJsonProperty,
      force: { type: 'boolean' },
      auto: { type: 'boolean' },
      smoke: { type: 'boolean' },
      profile: { type: 'string', enum: ['default', 'cli'] },
    }),
  },
  {
    name: 'har_launch_environment',
    description:
      'Start a FRESH agent session. Run this BEFORE editing any file: it returns workDir — ALL file edits must go under that path, never the main checkout. Relaunching replaces the previous session (refused if it has uncommitted changes unless force=true). Edits under workDir hot-reload in the running slot.',
    inputSchema: objectJsonSchema(
      {
        repo: repoJsonProperty,
        agentId: agentIdJsonProperty,
        worktree: { type: 'boolean' },
        claude: { type: 'boolean' },
        force: {
          type: 'boolean',
          description: 'Discard a dirty previous session instead of refusing to replace it',
        },
      },
      ['agentId'],
    ),
  },
  {
    name: 'har_run_stage',
    description: 'Run one generic harness stage by id or kind.',
    inputSchema: objectJsonSchema({
      repo: repoJsonProperty,
      stageId: { type: 'string' },
      kind: stageKindJsonProperty,
      agentId: agentIdJsonProperty,
      args: { type: 'array', items: { type: 'string' } },
    }),
  },
  {
    name: 'har_run_verification',
    description: 'Run the project verification pipeline for an agent slot.',
    inputSchema: objectJsonSchema(
      {
        repo: repoJsonProperty,
        agentId: agentIdJsonProperty,
        full: { type: 'boolean' },
      },
      ['agentId'],
    ),
  },
  {
    name: 'har_get_status',
    description: 'Return slot/process status for one agent or all slots.',
    inputSchema: objectJsonSchema({
      repo: repoJsonProperty,
      agentId: agentIdJsonProperty,
    }),
  },
  {
    name: 'har_get_logs',
    description: 'Return recent logs for a slot/process.',
    inputSchema: objectJsonSchema(
      {
        repo: repoJsonProperty,
        agentId: agentIdJsonProperty,
        service: { type: 'string' },
      },
      ['agentId'],
    ),
  },
  {
    name: 'har_teardown_environment',
    description: 'Stop a running agent environment slot. The session git branch is kept unless deleteBranch=true.',
    inputSchema: objectJsonSchema(
      {
        repo: repoJsonProperty,
        agentId: agentIdJsonProperty,
        deleteBranch: { type: 'boolean', description: 'Also delete the session git branch' },
      },
      ['agentId'],
    ),
  },
  {
    name: 'har_complete_environment',
    description:
      'Finish a session when the work is done: runs full verification (recorded as a validation of the worktree tree hash), tears the slot down, and KEEPS the session branch so the user can push it and open a PR.',
    inputSchema: objectJsonSchema(
      {
        repo: repoJsonProperty,
        agentId: agentIdJsonProperty,
        skipVerify: {
          type: 'boolean',
          description: 'Tear down without running verification (no validation is recorded)',
        },
      },
      ['agentId'],
    ),
  },
  {
    name: 'har_list_artifacts',
    description: 'List result JSON, screenshots, traces, reports, or other files under .har/artifacts/.',
    inputSchema: objectJsonSchema({
      repo: repoJsonProperty,
      stageId: { type: 'string' },
    }),
  },
  {
    name: 'har_list_runs',
    description: 'List persisted harness run records from .har/runs/.',
    inputSchema: objectJsonSchema({
      repo: repoJsonProperty,
      stageId: { type: 'string' },
      limit: { type: 'number' },
    }),
  },
  {
    name: 'har_get_run',
    description: 'Fetch one harness run record by runId.',
    inputSchema: objectJsonSchema(
      {
        repo: repoJsonProperty,
        runId: { type: 'string' },
      },
      ['runId'],
    ),
  },
];

function jsonContent(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

export async function handleMcpToolCall(
  toolName: string,
  args: Record<string, unknown>,
  defaultRepo = '.',
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const repo = (args.repo as string | undefined) ?? defaultRepo;

  switch (toolName) {
    case 'har_describe_project': {
      const description = describeProject(repo);
      const output = DescribeProjectOutputSchema.parse(description);
      return jsonContent(output);
    }

    case 'har_init_harness': {
      const input = InitHarnessInputSchema.parse({ ...args, repo });
      const result = await initHarness({
        repoPath: repo,
        force: input.force,
        auto: input.auto,
        smoke: input.smoke,
        profile: input.profile,
      });
      return jsonContent({
        harnessDir: result.harnessDir,
        validation: result.validation,
        smoke: result.smoke,
        adaptationSummary: result.adaptationSummary,
      });
    }

    case 'har_launch_environment': {
      const input = LaunchEnvironmentInputSchema.parse({ ...args, repo });
      const agentId = validateAgentId(input.agentId, repo);
      const result = await launchEnvironment({
        repoPath: repo,
        agentId,
        worktree: input.worktree,
        claude: input.claude,
        force: input.force,
        capture: true,
      });
      return jsonContent(LaunchEnvironmentOutputSchema.parse(result));
    }

    case 'har_run_stage': {
      const input = RunStageInputSchema.parse({ ...args, repo });
      const agentId = input.agentId !== undefined ? validateAgentId(input.agentId, repo) : undefined;
      const result = await runStage({
        repoPath: repo,
        stageId: input.stageId,
        kind: input.kind,
        agentId,
        args: input.args,
        capture: true,
        trigger: 'mcp',
      });
      return jsonContent(StageResultSchema.parse(result));
    }

    case 'har_run_verification': {
      const input = RunVerificationInputSchema.parse({ ...args, repo });
      const agentId = validateAgentId(input.agentId, repo);
      const result = await runVerification({
        repoPath: repo,
        agentId,
        full: input.full,
        capture: true,
        trigger: 'mcp',
      });
      return jsonContent(RunVerificationOutputSchema.parse(result));
    }

    case 'har_get_status': {
      const agentIdRaw = args.agentId as number | undefined;
      const agentId = agentIdRaw !== undefined ? validateAgentId(agentIdRaw, repo) : undefined;
      const result = await getEnvironmentStatus({
        repoPath: repo,
        agentId,
        capture: true,
        trigger: 'mcp',
      });
      return jsonContent(EnvironmentRunOutputSchema.parse(result));
    }

    case 'har_get_logs': {
      const input = GetLogsInputSchema.parse({ ...args, repo });
      const agentId = validateAgentId(input.agentId, repo);
      const result = await getEnvironmentLogs({
        repoPath: repo,
        agentId,
        service: input.service,
        trigger: 'mcp',
      });
      return jsonContent(EnvironmentRunOutputSchema.parse(result));
    }

    case 'har_teardown_environment': {
      const input = TeardownEnvironmentInputSchema.parse({ ...args, repo });
      const agentId = validateAgentId(input.agentId, repo);
      const result = await teardownEnvironment({
        repoPath: repo,
        agentId,
        deleteBranch: input.deleteBranch,
        capture: true,
        trigger: 'mcp',
      });
      return jsonContent(EnvironmentRunOutputSchema.parse(result));
    }

    case 'har_complete_environment': {
      const input = CompleteEnvironmentInputSchema.parse({ ...args, repo });
      const agentId = validateAgentId(input.agentId, repo);
      const result = await completeEnvironment({
        repoPath: repo,
        agentId,
        skipVerify: input.skipVerify,
        capture: true,
        trigger: 'mcp',
      });
      return jsonContent(CompleteEnvironmentOutputSchema.parse(result));
    }

    case 'har_list_artifacts': {
      const input = ListArtifactsInputSchema.parse({ ...args, repo });
      const artifacts = listArtifacts({ repoPath: repo, stageId: input.stageId });
      return jsonContent(ListArtifactsOutputSchema.parse({ artifacts }));
    }

    case 'har_list_runs': {
      const input = ListRunsInputSchema.parse({ ...args, repo });
      const runs = listRuns(repo, { stageId: input.stageId, limit: input.limit });
      return jsonContent(ListRunsOutputSchema.parse({ runs }));
    }

    case 'har_get_run': {
      const input = GetRunInputSchema.parse({ ...args, repo });
      const run = getRun(repo, input.runId);
      if (!run) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Run not found: ${input.runId}` }) }],
          isError: true,
        };
      }
      return jsonContent(GetRunOutputSchema.parse({ run }));
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

export async function runHarMcpServer(defaultRepo = '.'): Promise<void> {
  const server = new Server(
    { name: 'har', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: HAR_MCP_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      return await handleMcpToolCall(request.params.name, args, defaultRepo);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
