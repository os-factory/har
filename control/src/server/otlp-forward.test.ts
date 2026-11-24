import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffMs,
  drainOtlpSpool,
  enqueueOtlpForward,
  loadForwardDestinations,
  resolveSpoolDir,
} from './otlp-forward';

type Destination = {
  name: string;
  endpoint: string;
  headers?: Record<string, string>;
  signals: Array<'traces' | 'logs' | 'metrics'>;
  enabled?: boolean;
};

describe('otlp-forward', () => {
  let root: string;
  let destinationsDir: string;
  let spoolDir: string;

  const writeDestinations = (destinations: Destination[]) => {
    fs.mkdirSync(destinationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(destinationsDir, 'telemetry.json'),
      JSON.stringify({ version: 1, destinations: destinations.map((d) => ({ headers: {}, enabled: true, ...d })) }),
    );
  };
  const spoolEntries = () => (fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).filter((n) => n.endsWith('.json')) : []);
  const ok = () => vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'har-otlp-forward-'));
    destinationsDir = path.join(root, 'destinations');
    spoolDir = path.join(root, 'spool');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does nothing when no destinations are configured', () => {
    expect(loadForwardDestinations(destinationsDir)).toEqual([]);
    expect(enqueueOtlpForward('traces', Buffer.from('x'), { contentType: 'application/x-protobuf' }, { destinationsDir, spoolDir })).toBe(0);
    expect(fs.existsSync(spoolDir)).toBe(false);
  });

  it('ignores an invalid config file', () => {
    fs.mkdirSync(destinationsDir, { recursive: true });
    fs.writeFileSync(path.join(destinationsDir, 'telemetry.json'), '{"version":1,"destinations":[{"name":"x"}]}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(loadForwardDestinations(destinationsDir)).toEqual([]);
    warn.mockRestore();
  });

  it('forwards the raw body with its content type and encoding to <endpoint>/v1/<signal> with the destination headers', async () => {
    writeDestinations([
      { name: 'lf', endpoint: 'https://lf.example.com/api/public/otel/', headers: { Authorization: 'Basic abc' }, signals: ['traces'] },
      { name: 'col', endpoint: 'http://collector:4318', signals: ['traces', 'logs', 'metrics'] },
      { name: 'off', endpoint: 'http://off:4318', signals: ['traces'], enabled: false },
    ]);
    const body = Buffer.from([0x0a, 0x01, 0xff]);
    expect(
      enqueueOtlpForward('traces', body, { contentType: 'application/x-protobuf', contentEncoding: 'gzip' }, { destinationsDir, spoolDir }),
    ).toBe(2);
    // Header values never reach the spool.
    for (const name of fs.readdirSync(spoolDir)) {
      expect(fs.readFileSync(path.join(spoolDir, name), 'utf8')).not.toContain('Basic abc');
    }

    const fetchImpl = ok();
    const result = await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl });
    expect(result).toMatchObject({ sent: 2, dropped: 0, retried: 0 });
    const calls = fetchImpl.mock.calls.map(([url, init]) => ({ url, init: init as RequestInit }));
    expect(calls.map((call) => call.url).sort()).toEqual([
      'http://collector:4318/v1/traces',
      'https://lf.example.com/api/public/otel/v1/traces',
    ]);
    const lf = calls.find((call) => String(call.url).startsWith('https://lf'))!;
    expect(lf.init.headers).toMatchObject({
      Authorization: 'Basic abc',
      'content-type': 'application/x-protobuf',
      'content-encoding': 'gzip',
    });
    expect(Buffer.from(lf.init.body as Uint8Array).equals(body)).toBe(true);
    expect(fs.readdirSync(spoolDir)).toEqual([]);
  });

  it('only forwards a signal to destinations subscribed to it', () => {
    writeDestinations([{ name: 'lf', endpoint: 'https://lf.example.com', signals: ['traces'] }]);
    expect(enqueueOtlpForward('logs', Buffer.from('x'), { contentType: 'application/json' }, { destinationsDir, spoolDir })).toBe(0);
    expect(enqueueOtlpForward('metrics', Buffer.from('x'), { contentType: 'application/json' }, { destinationsDir, spoolDir })).toBe(0);
  });

  it('retries with backoff on 5xx and network errors, then drops after the attempt cap', async () => {
    writeDestinations([{ name: 'down', endpoint: 'http://down:4318', signals: ['traces'] }]);
    let clock = 1_000_000;
    const now = () => clock;
    enqueueOtlpForward('traces', Buffer.from('x'), { contentType: 'application/json' }, { destinationsDir, spoolDir, now });

    const failing = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
    expect(await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl: failing, now, maxAttempts: 3 })).toMatchObject({ retried: 1 });
    // Not due yet: no request.
    expect(await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl: failing, now, maxAttempts: 3 })).toMatchObject({ pending: 1 });
    expect(failing).toHaveBeenCalledTimes(1);

    clock += backoffMs(1);
    const refused = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl: refused, now, maxAttempts: 3 })).toMatchObject({ retried: 1 });

    clock += backoffMs(2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl: failing, now, maxAttempts: 3 })).toMatchObject({ dropped: 1 });
    warn.mockRestore();
    expect(fs.readdirSync(spoolDir)).toEqual([]);
  });

  it('drops a batch the destination rejects (4xx other than 408/429)', async () => {
    writeDestinations([{ name: 'lf', endpoint: 'https://lf.example.com', signals: ['traces'] }]);
    enqueueOtlpForward('traces', Buffer.from('x'), { contentType: 'application/json' }, { destinationsDir, spoolDir });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unauthorized = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    expect(await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl: unauthorized })).toMatchObject({ dropped: 1 });
    warn.mockRestore();

    enqueueOtlpForward('traces', Buffer.from('x'), { contentType: 'application/json' }, { destinationsDir, spoolDir });
    const limited = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }));
    expect(await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl: limited })).toMatchObject({ retried: 1 });
  });

  it('drops spooled copies older than the age cap or for a removed destination', async () => {
    writeDestinations([{ name: 'a', endpoint: 'http://a:4318', signals: ['traces'] }]);
    let clock = 5_000_000;
    const now = () => clock;
    enqueueOtlpForward('traces', Buffer.from('x'), { contentType: 'application/json' }, { destinationsDir, spoolDir, now });
    clock += 2_000;
    const fetchImpl = ok();
    expect(await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl, now, maxAgeMs: 1_000 })).toMatchObject({ dropped: 1 });

    enqueueOtlpForward('traces', Buffer.from('x'), { contentType: 'application/json' }, { destinationsDir, spoolDir, now });
    writeDestinations([{ name: 'b', endpoint: 'http://b:4318', signals: ['traces'] }]);
    // Force a re-read even if mtime resolution hides the rewrite.
    fs.utimesSync(path.join(destinationsDir, 'telemetry.json'), new Date(), new Date(Date.now() + 5_000));
    expect(await drainOtlpSpool({ destinationsDir, spoolDir, fetchImpl, now })).toMatchObject({ dropped: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caps the spool size by dropping the oldest copies', () => {
    writeDestinations([{ name: 'a', endpoint: 'http://a:4318', signals: ['traces'] }]);
    let clock = 1;
    const now = () => clock++;
    for (let i = 0; i < 10; i += 1) {
      enqueueOtlpForward('traces', Buffer.alloc(1000), { contentType: 'application/json' }, { destinationsDir, spoolDir, now, maxSpoolBytes: 4000 });
    }
    const entries = spoolEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(4);
    // The newest copy survives.
    expect(entries.sort().at(-1)).toMatch(/^0+10-/);
  });

  it('delivers to a real HTTP server', async () => {
    const received: Array<{ url?: string; type?: string; auth?: string; body: Buffer }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ url: req.url, type: req.headers['content-type'], auth: req.headers.authorization, body: Buffer.concat(chunks) });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      writeDestinations([{ name: 'local', endpoint: `http://127.0.0.1:${port}/otel`, headers: { Authorization: 'Bearer t' }, signals: ['logs'] }]);
      enqueueOtlpForward('logs', Buffer.from('{"resourceLogs":[]}'), { contentType: 'application/json' }, { destinationsDir, spoolDir });
      expect(await drainOtlpSpool({ destinationsDir, spoolDir })).toMatchObject({ sent: 1 });
      expect(received).toEqual([{ url: '/otel/v1/logs', type: 'application/json', auth: 'Bearer t', body: Buffer.from('{"resourceLogs":[]}') }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('puts the spool next to an absolute SQLite file, else in tmp', () => {
    expect(resolveSpoolDir({ DATABASE_URL: 'file:/data/har_control.db' })).toBe('/data/otlp-spool');
    expect(resolveSpoolDir({ DATABASE_URL: 'file:./agent_3.db' })).toBe(path.join(os.tmpdir(), 'har-control-otlp-spool'));
    expect(resolveSpoolDir({ HAR_OTLP_SPOOL_DIR: '/x/spool', DATABASE_URL: 'file:/data/a.db' })).toBe('/x/spool');
  });
});
