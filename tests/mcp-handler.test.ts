import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleMcpToolCall } from '../src/mcp/server';
import { detectDockerStatus } from '../src/core/docker-status';

jest.mock('../src/core/docker-status', () => {
  const actual = jest.requireActual('../src/core/docker-status') as typeof import('../src/core/docker-status');
  return {
    ...actual,
    detectDockerStatus: jest.fn(() => ({
      cliInstalled: false,
      daemonRunning: false,
    })),
  };
});

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

describe('handleMcpToolCall', () => {
  it('describes a fixture project', async () => {
    const response = await handleMcpToolCall('har_describe_project', { repo: FIXTURE });
    expect(response.isError).toBeUndefined();
    const payload = JSON.parse(response.content[0].text);
    expect(payload.harnessPresent).toBe(true);
    expect(payload.stages.some((stage: { id: string }) => stage.id === 'verify')).toBe(true);
  });

  it('reports Docker availability when scaffolding a harness', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-mcp-init-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'mcp-init-fixture', version: '1.0.0' }, null, 2) + '\n',
    );
    try {
      const response = await handleMcpToolCall('har_init_harness', {
        repo: tmpDir,
        profile: 'cli',
      });
      const payload = JSON.parse(response.content[0].text);
      expect(detectDockerStatus).toHaveBeenCalled();
      expect(payload.docker).toMatchObject({
        cliInstalled: false,
        daemonRunning: false,
      });
      expect(payload.docker.warning).toContain('Docker is required');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('returns structured errors for unknown tools', async () => {
    await expect(handleMcpToolCall('har_unknown_tool', {})).rejects.toThrow('Unknown tool');
  });
});
