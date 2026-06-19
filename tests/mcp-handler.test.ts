import * as path from 'path';
import { handleMcpToolCall } from '../src/mcp/server';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

describe('handleMcpToolCall', () => {
  it('describes a fixture project', async () => {
    const response = await handleMcpToolCall('har_describe_project', { repo: FIXTURE });
    expect(response.isError).toBeUndefined();
    const payload = JSON.parse(response.content[0].text);
    expect(payload.harnessPresent).toBe(true);
    expect(payload.stages.some((stage: { id: string }) => stage.id === 'verify')).toBe(true);
  });

  it('returns structured errors for unknown tools', async () => {
    await expect(handleMcpToolCall('har_unknown_tool', {})).rejects.toThrow('Unknown tool');
  });
});
