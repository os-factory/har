import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTemplateFile } from '../src/utils/paths';

const tmpDirs: string[] = [];

function scaffoldEcosystemConfig(agentId = 1): { dir: string; configPath: string } {
  const templatePath = resolveTemplateFile('runtime-bundles/pm2-runtime/ecosystem.agent.template.cjs');
  if (!templatePath) {
    throw new Error('ecosystem.agent.template.cjs template not found');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-ecosystem-'));
  tmpDirs.push(dir);

  const template = fs
    .readFileSync(templatePath, 'utf8')
    .replace(/\$\{AGENT_ID\}/g, String(agentId))
    .replace(/\$\{HARNESS_PROJECT_NAME\}/g, 'test-project');

  const configPath = path.join(dir, 'ecosystem.agent.' + agentId + '.config.cjs');
  fs.writeFileSync(configPath, template);
  fs.writeFileSync(
    path.join(dir, '.env.agent.' + agentId),
  'API_PORT=4100\nPORT=4200\n# comment\nQUOTED="hello"\n',
  );

  return { dir, configPath };
}

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ecosystem.agent.template.cjs', () => {
  it('loads .env.agent.<id> without requiring dotenv from node_modules', () => {
    const { configPath } = scaffoldEcosystemConfig();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require(configPath);

    expect(config.apps[0].env.API_PORT).toBe('4100');
    expect(config.apps[0].env.PORT).toBe('4100');
    expect(config.apps[0].env.QUOTED).toBe('hello');
  });

  it('tolerates a missing .env.agent.<id> file', () => {
    const { dir, configPath } = scaffoldEcosystemConfig(2);
    fs.unlinkSync(path.join(dir, '.env.agent.2'));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require(configPath);

    expect(config.apps[0].env.NODE_ENV).toBe('development');
    expect(config.apps[0].env.PORT).toBeUndefined();
  });
});
