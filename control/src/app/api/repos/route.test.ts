import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerRepository = vi.fn();

vi.mock('@/server/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/repositories')>();
  return {
    ...actual,
    registerRepository: (...args: unknown[]) => registerRepository(...args),
  };
});

import { RepositoryUnregisteredError } from '@/server/repositories';
import { POST } from './route';

describe('POST /api/repos', () => {
  beforeEach(() => {
    registerRepository.mockReset();
  });

  it('returns 409 when repository was previously unregistered', async () => {
    registerRepository.mockRejectedValue(new RepositoryUnregisteredError('/tmp/main'));

    const response = await POST(
      new Request('http://localhost/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/tmp/main' }),
      }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; path: string };
    expect(body.path).toBe('/tmp/main');
    expect(body.error).toContain('/tmp/main');
  });

  it('returns 200 with repo id on successful register', async () => {
    registerRepository.mockResolvedValue({ id: 'repo-1', path: '/tmp/main' });

    const response = await POST(
      new Request('http://localhost/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/tmp/main' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'repo-1', path: '/tmp/main' });
  });

  it('returns 400 for other register errors', async () => {
    registerRepository.mockRejectedValue(new Error('invalid input'));

    const response = await POST(
      new Request('http://localhost/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/tmp/main' }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'invalid input',
    });
  });
});
