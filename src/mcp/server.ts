import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { describeProject, initHarness } from '../core/harness';
import {
  getEnvironmentLogs,
  getEnvironmentStatus,
  launchEnvironment,
  listArtifacts,
  runStage,
  runVerification,
  teardownEnvironment,
} from '../core/run-service';
import {
  agentIdJsonProperty,
  objectJsonSchema,
  repoJsonProperty,
  stageKindJsonProperty,
} from './schema-tools';
import { validateAgentId } from '../utils/validation';
import {
  DescribeProjectOutputSchema,
  EnvironmentRunOutputSchema,
  GetLogsInputSchema,
  InitHarnessInputSchema,
  LaunchEnvironmentInputSchema,
  LaunchEnvironmentOutputSchema,
  ListArtifactsInputSchema,
  ListArtifactsOutputSchema,
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
    description: 'Scaffold .har/ boilerplate. Use skipLlm=true for template-only init.',
    inputSchema: objectJsonSchema({
      repo: repoJsonProperty,
      force: { type: 'boolean' },
      skipLlm: { type: 'boolean' },
      smoke: { type: 'boolean' },
      profile: { type: 'string', enum: ['default', 'cli'] },
    }),
  },
  {
    name: 'har_launch_environment',
    description: 'Launch an agent environment slot and return ports or preview URLs when available.',
    inputSchema: objectJsonSchema(
      {
        repo: repoJsonProperty,
        agentId: agentIdJsonProperty,
        worktree: { type: 'boolean' },
        claude: { type: 'boolean' },
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
    description: 'Stop a running agent environment slot.',
    inputSchema: objectJsonSchema(
      {
        repo: repoJsonProperty,
        agentId: agentIdJsonProperty,
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
        skipLlm: input.skipLlm,
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
      const input = RunVerificationInputSchema.pick({ repo: true, agentId: true }).parse({
        ...args,
        repo,
      });
      const agentId = validateAgentId(input.agentId, repo);
      const result = await teardownEnvironment({
        repoPath: repo,
        agentId,
        capture: true,
        trigger: 'mcp',
      });
      return jsonContent(EnvironmentRunOutputSchema.parse(result));
    }

    case 'har_list_artifacts': {
      const input = ListArtifactsInputSchema.parse({ ...args, repo });
      const artifacts = listArtifacts({ repoPath: repo, stageId: input.stageId });
      return jsonContent(ListArtifactsOutputSchema.parse({ artifacts }));
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
