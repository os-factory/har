import { describe, expect, it } from 'vitest';
import { displayCommand, stageMeta, stageTitle } from './stage-meta';

describe('stageTitle', () => {
  it('title-cases stage ids and keeps acronyms', () => {
    expect(stageTitle('unit-tests')).toBe('Unit tests');
    expect(stageTitle('typecheck')).toBe('Typecheck');
    expect(stageTitle('browser-e2e')).toBe('Browser E2E');
    expect(stageTitle('api-health')).toBe('API health');
    expect(stageTitle('docs_build')).toBe('Docs build');
  });
});

describe('stageMeta', () => {
  it('describes a stage from stages.json: kind and command, never a guessed tool', () => {
    const meta = stageMeta({ name: 'unit-tests', kind: 'test', command: 'node --test', description: 'Unit tests' });
    expect(meta.title).toBe('Unit tests');
    expect(meta.subtitle).toBe('test · node --test');
    expect(meta.detail).toBe('Unit tests — node --test');
    expect(`${meta.subtitle} ${meta.detail}`).not.toMatch(/vitest|eslint/i);
  });

  it('expands shell defaults in the command', () => {
    expect(displayCommand('${NPM_BIN:-npm} run lint')).toBe('npm run lint');
    expect(stageMeta({ name: 'lint', kind: 'test', command: '${NPM_BIN:-npm} run lint' }).subtitle).toBe('test · npm run lint');
  });

  it('falls back to the kind, then to a neutral label, without a registry entry', () => {
    expect(stageMeta({ name: 'readiness', kind: 'test' }).subtitle).toBe('test stage');
    const bare = stageMeta('unit-tests');
    expect(bare.title).toBe('Unit tests');
    expect(bare.subtitle).toBe('Verification step');
    expect(bare.detail).toBeNull();
  });
});
