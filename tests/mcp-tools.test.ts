import { HAR_MCP_TOOLS } from '../src/mcp/server';
import { HAR_STAGE_KINDS } from '../src/harness/schema';

describe('HAR MCP tool schemas', () => {
  it('exposes a small generic tool surface', () => {
    const names = HAR_MCP_TOOLS.map((tool) => tool.name);

    expect(names).toEqual([
      'har_describe_project',
      'har_init_harness',
      'har_launch_environment',
      'har_run_stage',
      'har_run_verification',
      'har_get_status',
      'har_get_logs',
      'har_teardown_environment',
      'har_list_artifacts',
    ]);
    expect(names).not.toContain('run_playwright');
  });

  it('publishes JSON schemas for all tool inputs', () => {
    for (const tool of HAR_MCP_TOOLS) {
      expect(tool.inputSchema).toMatchObject({
        type: 'object',
        properties: expect.any(Object),
      });
    }

    const runStage = HAR_MCP_TOOLS.find((tool) => tool.name === 'har_run_stage');
    expect(runStage?.inputSchema).toMatchObject({
      properties: {
        kind: {
          enum: [...HAR_STAGE_KINDS],
        },
      },
    });
  });
});
