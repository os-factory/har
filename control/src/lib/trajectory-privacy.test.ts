import { describe, expect, it } from 'vitest';
import {
  boundTrajectoryPayload,
  hidesTrajectoryContent,
  isSecretAttributeKey,
  payloadByteLength,
  redactSecretAttributes,
  trajectoryPolicy,
  visibleContentFromPayload,
} from './trajectory-privacy';

describe('secret attribute keys', () => {
  it('redacts credential leaves without treating token counters as secrets', () => {
    expect(isSecretAttributeKey('authorization')).toBe(true);
    expect(isSecretAttributeKey('gen_ai.request.api_key')).toBe(true);
    expect(isSecretAttributeKey('openai.access_token')).toBe(true);
    expect(isSecretAttributeKey('gen_ai.usage.input_tokens')).toBe(false);
    expect(isSecretAttributeKey('otelhook.content.hash')).toBe(false);
    expect(redactSecretAttributes({
      authorization: 'Bearer secret',
      'gen_ai.usage.input_tokens': 12,
    })).toEqual({
      authorization: '[redacted]',
      'gen_ai.usage.input_tokens': 12,
    });
  });
});

describe('trajectory policy', () => {
  it('defaults to a 64KiB payload cap and unlimited retention', () => {
    expect(trajectoryPolicy({})).toEqual({
      maxPayloadBytes: 65_536,
      retentionDays: 0,
    });
    expect(trajectoryPolicy({
      HAR_TRAJECTORY_MAX_PAYLOAD_BYTES: '2048',
      HAR_TRAJECTORY_RETENTION_DAYS: '14',
    })).toEqual({
      maxPayloadBytes: 2048,
      retentionDays: 14,
    });
  });
});

describe('payload bounds and disclosure', () => {
  it('drops withheld bodies and secret attributes before persistence', () => {
    const bounded = boundTrajectoryPayload({
      body: 'should never be stored',
      promptText: 'also secret',
      attributes: { authorization: 'Bearer abc', 'gen_ai.tool.name': 'Read' },
    }, 'withheld');
    expect(bounded.contentDisclosure).toBe('withheld');
    expect(bounded.payload.body).toBeNull();
    expect(bounded.payload.promptText).toBeNull();
    expect(bounded.payload.attributes).toEqual({
      authorization: '[redacted]',
      'gen_ai.tool.name': 'Read',
    });
    expect(visibleContentFromPayload(bounded.payload, 'prompt', bounded.contentDisclosure)).toEqual({
      promptText: null,
      responseText: null,
      raw: null,
    });
  });

  it('omits binary bodies instead of storing them as text', () => {
    const bounded = boundTrajectoryPayload({
      body: Buffer.from([0, 1, 2, 3]),
      attributes: {},
    }, 'full');
    expect(bounded.contentDisclosure).toBe('metadata_only');
    expect(bounded.payload.body).toBeNull();
    expect(bounded.payload.binaryOmitted).toBe(true);
  });

  it('truncates oversized tool payloads and marks disclosure', () => {
    const bounded = boundTrajectoryPayload({
      body: 'x'.repeat(8_000),
      attributes: {},
    }, 'full', 1_024);
    expect(bounded.contentDisclosure).toBe('truncated');
    expect(payloadByteLength(bounded.payload)).toBeLessThanOrEqual(1_024);
    expect(String(bounded.payload.body)).toMatch(/…$/);
  });

  it('does not expose withheld or metadata-only content as visible text', () => {
    expect(hidesTrajectoryContent('withheld')).toBe(true);
    expect(visibleContentFromPayload({
      body: 'hidden',
      promptText: 'hidden prompt',
    }, 'prompt', 'metadata_only')).toEqual({
      promptText: null,
      responseText: null,
      raw: null,
    });
  });
});
