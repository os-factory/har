import * as fs from 'fs';
import * as os from 'os';
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
      expect(typeof payload.docker.cliInstalled).toBe('boolean');
      expect(typeof payload.docker.daemonRunning).toBe('boolean');
      if (payload.docker.cliInstalled && payload.docker.daemonRunning) {
        expect(payload.docker.warning).toBeNull();
      } else {
        expect(payload.docker.warning).toContain('Docker is required');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns structured errors for unknown tools', async () => {
    await expect(handleMcpToolCall('har_unknown_tool', {})).rejects.toThrow('Unknown tool');
  });
});
