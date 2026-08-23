import * as fs from 'fs';
import * as path from 'path';
import {
  parseHarnessEnvSource,
  parsePortLanes,
  validateHarnessEnvSource,
} from '../packages/schemas/src/harness-env';

const TEMPLATES = [
  'src/templates/har-boilerplate/harness.env',
  'src/templates/har-boilerplate-cli/harness.env',
  'src/templates/har-boilerplate-ios/harness.env',
];

describe('harness.env pure-config contract (#230)', () => {
  it.each(TEMPLATES)('%s is pure KEY=value and schema-valid', (rel) => {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const substituted = text.replace(/__PROJECT_NAME__/g, 'fixture');
    const result = validateHarnessEnvSource(substituted);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.config?.HARNESS_PROJECT_NAME).toBe('fixture');
  });

  it('flags function definitions with an actionable error', () => {
    const result = validateHarnessEnvSource(
      [
        'export HARNESS_PROJECT_NAME=x',
        'har_pg() {',
        '  echo hi',
        '}',
      ].join('\n'),
    );
    expect(result.ok).toBe(false);
    const fnIssue = result.issues.find((i) => i.message.includes('har_pg()'));
    expect(fnIssue?.severity).toBe('error');
    expect(fnIssue?.message).toContain('.har/lib/');
    expect(fnIssue?.line).toBe(2);
    // function body lines are not misread as config
    expect(result.config?.HARNESS_PROJECT_NAME).toBe('x');
  });

  it('flags unknown HARNESS_* keys with a suggestion', () => {
    const result = validateHarnessEnvSource(
      'export HARNESS_PROJECT_NAME=x\nexport HARNESS_ECOSYSTM=node\n',
    );
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.key === 'HARNESS_ECOSYSTM');
    expect(issue?.message).toContain('HARNESS_ECOSYSTEM');
  });

  it('reports missing required keys', () => {
    const result = validateHarnessEnvSource('export HARNESS_ECOSYSTEM=node\n');
    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (i) => i.key === 'HARNESS_PROJECT_NAME' && i.severity === 'error',
      ),
    ).toBe(true);
  });

  it('rejects invalid enum values with the offending value', () => {
    const result = validateHarnessEnvSource(
      'export HARNESS_PROJECT_NAME=x\nexport HARNESS_ECOSYSTEM=cobol\n',
    );
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.key === 'HARNESS_ECOSYSTEM');
    expect(issue?.message).toContain('cobol');
  });

  it('tolerates legacy port triplets as warnings', () => {
    const result = validateHarnessEnvSource(
      [
        'export HARNESS_PROJECT_NAME=x',
        'export HARNESS_DB_PORT_DEFAULT=15432',
        'export HARNESS_DB_PORT_SCAN_START=15432',
        'export HARNESS_DB_PORT_SCAN_END=15499',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    const warning = result.issues.find((i) => i.key === 'HARNESS_DB_PORT_DEFAULT');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('HARNESS_INFRA_PORT_LANES');
  });

  it('keeps quoted values verbatim and drops trailing comments', () => {
    const parsed = parseHarnessEnvSource(
      [
        'export HARNESS_PROJECT_NAME="my app"   # trailing comment',
        "export HARNESS_XCODE_WORKSPACE=''     # e.g. MyApp.xcworkspace",
        'export HARNESS_PORT_STEP=10 # step',
      ].join('\n'),
    );
    expect(parsed.values.HARNESS_PROJECT_NAME).toBe('my app');
    expect(parsed.values.HARNESS_XCODE_WORKSPACE).toBe('');
    expect(parsed.values.HARNESS_PORT_STEP).toBe('10');
  });
});

describe('HARNESS_INFRA_PORT_LANES parsing', () => {
  it('parses the shipped default lanes', () => {
    const { lanes, issues } = parsePortLanes(
      'db=15432:15432-15499 minio=19000:19000-19099 minio-console=19001:19001-19099 browser=13001:13001-13099 mailpit-web=18025:18025-18099 mailpit-smtp=11025:11025-11099',
    );
    expect(Object.keys(lanes)).toHaveLength(6);
    expect(lanes.db).toEqual({ default: 15432, scanStart: 15432, scanEnd: 15499 });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('rejects malformed entries with the expected syntax in the message', () => {
    const { issues } = parsePortLanes('db=15432');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('<lane>=<default>:<scan_start>-<scan_end>');
  });

  it('rejects inverted ranges and duplicate lanes', () => {
    expect(parsePortLanes('db=15432:15499-15432').issues[0].severity).toBe('error');
    const dup = parsePortLanes('db=1:1-2 db=3:3-4');
    expect(dup.issues.some((i) => i.message.includes('Duplicate'))).toBe(true);
  });

  it('warns on overlapping scan ranges', () => {
    const { issues } = parsePortLanes('db=15432:15400-15499 minio=15450:15450-15550');
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('overlap'))).toBe(
      true,
    );
  });
});
