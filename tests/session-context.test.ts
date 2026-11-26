import {
  SESSION_CONTEXT_VERSION,
  SessionContextSchema,
  assertSessionContextAttributes,
  segmentInForce,
  sessionContextAttributeProblems,
  sessionContextRelativePath,
  type SessionContext,
} from '../packages/schemas/src/index';

const ATTEMPT_A = '2e622700-a56b-42c3-8cfa-a07172bbbf00';
const ATTEMPT_B = '41d5c854-04a6-48b1-ba97-b6e9e2c89d2d';

function attrs(attempt: string, slot: string): Record<string, string> {
  return {
    'factory.work_unit.id': '416',
    'factory.work_unit.source': 'github',
    'factory.attempt.id': attempt,
    'factory.slot.id': slot,
    'vcs.repository.url.full': 'https://github.com/os-factory/har',
    'vcs.ref.head.name': `next-77b6-har-agent-${slot}-w9jz`,
  };
}

/** ADR 0004 section 2, plus a relaunch into slot 2. */
function context(): SessionContext {
  return {
    version: 1,
    agentTool: 'claude_code',
    sessionId: '8f0c2d1e-1111-4222-8333-944455556666',
    segments: [
      { from: '2026-11-25T10:02:11.000Z', to: '2026-11-25T11:00:00.000Z', reason: 'launch', attributes: attrs(ATTEMPT_A, '1') },
      { from: '2026-11-25T11:00:00.000Z', to: null, reason: 'launch', attributes: attrs(ATTEMPT_B, '2') },
    ],
  };
}

describe('session context schema (ADR 0004 section 2)', () => {
  it('accepts the ADR example and pins version 1', () => {
    expect(SESSION_CONTEXT_VERSION).toBe(1);
    expect(SessionContextSchema.parse(context())).toEqual(context());
    expect(SessionContextSchema.safeParse({ ...context(), version: 2 }).success).toBe(false);
  });

  it('rejects factory.local.* keys and path values', () => {
    const local = context();
    local.segments[1].attributes['factory.local.work_dir'] = 'not-a-path-but-forbidden';
    expect(SessionContextSchema.safeParse(local).success).toBe(false);

    for (const value of ['/home/me/repo', '~/repo', 'C:\\repo', 'D:/repo', '\\\\server\\share']) {
      const withPath = context();
      withPath.segments[0].attributes['vcs.ref.head.name'] = value;
      expect(SessionContextSchema.safeParse(withPath).success).toBe(false);
    }
    expect(sessionContextAttributeProblems(attrs(ATTEMPT_A, '1'))).toEqual([]);
    expect(() => assertSessionContextAttributes({ 'factory.local.checkout_path': '/x' })).toThrow(/factory\.local/);
  });

  it('allows at most one open segment, the last, and no overlap', () => {
    const twoOpen = context();
    twoOpen.segments[0].to = null;
    expect(SessionContextSchema.safeParse(twoOpen).success).toBe(false);

    const overlap = context();
    overlap.segments[1].from = '2026-11-25T10:59:59.000Z';
    expect(SessionContextSchema.safeParse(overlap).success).toBe(false);

    const backwards = context();
    backwards.segments[0].to = '2026-11-25T10:00:00.000Z';
    expect(SessionContextSchema.safeParse(backwards).success).toBe(false);

    expect(SessionContextSchema.safeParse({ ...context(), segments: [] }).success).toBe(true);
  });

  it('keeps agent tool and session id path-safe', () => {
    expect(sessionContextRelativePath('claude_code', 'abc-123')).toBe('claude_code/abc-123.json');
    for (const [tool, id] of [
      ['claude_code', '../etc'],
      ['claude_code', 'a/b'],
      ['claude_code', 'a..b'],
      ['../x', 'abc'],
      ['Claude', 'abc'],
    ]) {
      expect(() => sessionContextRelativePath(tool, id)).toThrow();
    }
  });
});

describe('segmentInForce', () => {
  it('finds the segment whose [from, to) holds the timestamp', () => {
    const ctx = context();
    expect(segmentInForce(ctx, '2026-11-25T10:02:10.999Z')).toBeUndefined();
    expect(segmentInForce(ctx, '2026-11-25T10:02:11.000Z')?.attributes['factory.slot.id']).toBe('1');
    expect(segmentInForce(ctx, new Date('2026-11-25T10:30:00Z'))?.attributes['factory.slot.id']).toBe('1');
    // At the relaunch instant the new segment is in force.
    expect(segmentInForce(ctx, Date.parse('2026-11-25T11:00:00Z'))?.attributes['factory.slot.id']).toBe('2');
    expect(segmentInForce(ctx, '2027-01-01T00:00:00Z')?.attributes['factory.slot.id']).toBe('2');
    expect(segmentInForce(ctx, 'not a date')).toBeUndefined();
  });

  it('stamps nothing in a gap or after a closed last segment', () => {
    const ctx = context();
    ctx.segments[1] = { ...ctx.segments[1], from: '2026-11-25T12:00:00.000Z', to: '2026-11-25T13:00:00.000Z' };
    expect(segmentInForce(ctx, '2026-11-25T11:30:00Z')).toBeUndefined();
    expect(segmentInForce(ctx, '2026-11-25T13:00:00Z')).toBeUndefined();
    expect(segmentInForce({ segments: [] }, '2026-11-25T11:30:00Z')).toBeUndefined();
  });

  it('treats an open segment of an ended attempt as closed', () => {
    const ctx = context();
    const ended = new Set([ATTEMPT_B]);
    expect(segmentInForce(ctx, '2026-11-25T12:00:00Z', { isAttemptEnded: (id) => ended.has(id) })).toBeUndefined();
    expect(segmentInForce(ctx, '2026-11-25T10:30:00Z', { isAttemptEnded: (id) => ended.has(id) })).toBeDefined();
  });
});
