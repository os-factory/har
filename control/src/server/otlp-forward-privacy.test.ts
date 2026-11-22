import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainOtlpSpool, enqueueOtlpForward } from './otlp-forward';

const LOGS_WITH_PATHS = JSON.stringify({
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'har' } },
          { key: 'har.repo_path', value: { stringValue: '/home/me/repo' } },
          { key: 'har.work_dir', value: { stringValue: '/home/me/worktrees/slot-1' } },
        ],
      },
      scopeLogs: [{ scope: { name: 'har' }, logRecords: [{ body: { stringValue: 'ok' }, attributes: [] }] }],
    },
  ],
});

describe('otlp-forward local path stripping', () => {
  let root: string;
  let destinationsDir: string;
  let spoolDir: string;

  const writeDestinations = (destinations: Array<Record<string, unknown>>) => {
    fs.mkdirSync(destinationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(destinationsDir, 'telemetry.json'),
      JSON.stringify({ version: 1, destinations: destinations.map((d) => ({ headers: {}, enabled: true, signals: ['logs'], ...d })) }),
    );
  };
  const spoolBodies = () =>
    fs.readdirSync(spoolDir).filter((n) => n.endsWith('.body')).map((n) => fs.readFileSync(path.join(spoolDir, n), 'utf8'));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'har-otlp-privacy-'));
    destinationsDir = path.join(root, 'destinations');
    spoolDir = path.join(root, 'spool');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('strips local paths before the spool unless the destination opted in', async () => {
    writeDestinations([
      { name: 'lf', endpoint: 'https://lf.example.com' },
      { name: 'mine', endpoint: 'http://collector:4318', includeLocalPaths: true },
    ]);
    const body = Buffer.from(LOGS_WITH_PATHS);
    expect(enqueueOtlpForward('logs', body, { contentType: 'application/json' }, { destinationsDir, spoolDir })).toBe(2);
    const bodies = spoolBodies();
    expect(bodies.filter((b) => b.includes('/home/me'))).toHaveLength(1);

    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl });
    const sent = Object.fromEntries(
      fetchImpl.mock.calls.map(([url, init]) => [String(url), Buffer.from((init as RequestInit).body as Uint8Array).toString()]),
    );
    expect(sent['https://lf.example.com/v1/logs']).not.toContain('/home/me');
    expect(sent['https://lf.example.com/v1/logs']).toContain('service.name');
    expect(sent['http://collector:4318/v1/logs']).toBe(LOGS_WITH_PATHS);
  });

  it('does not queue a body whose local paths cannot be checked', () => {
    writeDestinations([{ name: 'lf', endpoint: 'https://lf.example.com' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = Buffer.from('{"har.repo_path": not json');
    expect(enqueueOtlpForward('logs', body, { contentType: 'application/json' }, { destinationsDir, spoolDir })).toBe(0);
    expect(enqueueOtlpForward('logs', Buffer.from(LOGS_WITH_PATHS), { contentType: 'application/json', contentEncoding: 'zstd' }, { destinationsDir, spoolDir })).toBe(0);
    warn.mockRestore();
  });

  it('drops a spooled copy with local paths once the destination withdraws the opt-in', async () => {
    writeDestinations([{ name: 'mine', endpoint: 'http://collector:4318', includeLocalPaths: true }]);
    enqueueOtlpForward('logs', Buffer.from(LOGS_WITH_PATHS), { contentType: 'application/json' }, { destinationsDir, spoolDir });
    // A distinct size so the cached config is re-read.
    writeDestinations([{ name: 'mine', endpoint: 'http://collector:4318', includeLocalPaths: false }]);
    const fetchImpl = vi.fn();
    expect(await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl })).toMatchObject({ sent: 0, dropped: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const LOGS_WITH_IDENTITY = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events' },
            logRecords: [
              {
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  { key: 'user.email', value: { stringValue: 'someone@example.com' } },
                  { key: 'user.account_uuid', value: { stringValue: '0000-acct' } },
                  { key: 'session.id', value: { stringValue: 's-1' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  it('strips account identity before the spool unless the destination opted in', async () => {
    writeDestinations([
      { name: 'lf', endpoint: 'https://lf.example.com' },
      { name: 'paths', endpoint: 'http://paths:4318', includeLocalPaths: true },
      { name: 'mine', endpoint: 'http://collector:4318', includeAccountIdentity: true },
    ]);
    const body = Buffer.from(LOGS_WITH_IDENTITY);
    expect(enqueueOtlpForward('logs', body, { contentType: 'application/json' }, { destinationsDir, spoolDir })).toBe(3);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl });
    const sent = Object.fromEntries(
      fetchImpl.mock.calls.map(([url, init]) => [String(url), Buffer.from((init as RequestInit).body as Uint8Array).toString()]),
    );
    for (const url of ['https://lf.example.com/v1/logs', 'http://paths:4318/v1/logs']) {
      expect(sent[url]).not.toContain('someone@example.com');
      expect(sent[url]).not.toContain('0000-acct');
      expect(sent[url]).toContain('s-1');
    }
    expect(sent['http://collector:4318/v1/logs']).toBe(LOGS_WITH_IDENTITY);
  });

  it('drops a spooled copy with account identity once the destination withdraws the opt-in', async () => {
    writeDestinations([{ name: 'mine', endpoint: 'http://collector:4318', includeAccountIdentity: true }]);
    enqueueOtlpForward('logs', Buffer.from(LOGS_WITH_IDENTITY), { contentType: 'application/json' }, { destinationsDir, spoolDir });
    // A distinct size so the cached config is re-read.
    writeDestinations([{ name: 'mine', endpoint: 'http://collector:4318', includeAccountIdentity: false }]);
    const fetchImpl = vi.fn();
    expect(await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl })).toMatchObject({ sent: 0, dropped: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
