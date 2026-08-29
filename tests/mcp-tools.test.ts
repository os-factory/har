import { HAR_MCP_TOOLS } from '../src/mcp/server';
import { HAR_STAGE_KINDS } from '../src/harness/schema';

describe('HAR MCP tool schemas', () => {
  it('exposes a small generic tool surface', () => {
    const names = HAR_MCP_TOOLS.map((tool) => tool.name);

    expect(names).toEqual([
      'har_describe_project',
      'har_init_harness',
      'har_maintain',
      'har_add_plugin',
      'har_launch_environment',
      'har_add_work_unit_link',
      'har_recover_environment',
      'har_preflight_environment',
      'har_run_stage',
      'har_run_verification',
      'har_doctor',
      'har_get_status',
      'har_get_logs',
      'har_teardown_environment',
      'har_complete_environment',
      'har_list_artifacts',
      'har_list_runs',
      'har_get_run',
      'har_control_up',
      'har_line_create',
      'har_add_line',
      'har_line_status',
      'har_run_line_gate',
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
