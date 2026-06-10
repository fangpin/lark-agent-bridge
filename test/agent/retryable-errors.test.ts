import { describe, expect, test } from 'vitest';
import { isRetryableUpstreamRateLimitError } from '../../src/agent/retryable-errors';

describe('isRetryableUpstreamRateLimitError', () => {
  test('recognizes prefixed API Error context containing a 429', () => {
    expect(isRetryableUpstreamRateLimitError('agent 失败: API Error: upstream returned status 429 after retry')).toBe(
      true,
    );
  });

  test('recognizes API Error context with non-exact rate limit wording', () => {
    expect(isRetryableUpstreamRateLimitError('API Error: upstream returned HTTP 429 from provider')).toBe(true);
  });

  test('recognizes Chinese runtime prefix with full-width colon', () => {
    expect(
      isRetryableUpstreamRateLimitError('⚠️ agent 失败：API Error: upstream returned status 429 after retry'),
    ).toBe(true);
    expect(isRetryableUpstreamRateLimitError('agent 失败：API Error: upstream returned status 429 after retry')).toBe(
      true,
    );
  });

  test('recognizes Codex process-exit API Error context containing a 429', () => {
    expect(
      isRetryableUpstreamRateLimitError(
        'codex exited with code 1: API Error: Request rejected (429) · upstream error',
      ),
    ).toBe(true);
  });

  test('does not match 429 inside request identifiers', () => {
    expect(isRetryableUpstreamRateLimitError('API Error: authentication failed for request req_429abc')).toBe(false);
  });

  test('does not match 429 adjacent to underscores in request identifiers', () => {
    expect(isRetryableUpstreamRateLimitError('API Error: request req_429 failed')).toBe(false);
  });

  test('does not match 429 inside negative provider codes', () => {
    expect(isRetryableUpstreamRateLimitError('API Error: provider returned code -1429')).toBe(false);
  });

  test('recognizes API Error context containing Too Many Requests', () => {
    expect(isRetryableUpstreamRateLimitError('agent failed: API Error: upstream says Too Many Requests')).toBe(true);
  });

  test('does not treat explanatory prose mentioning API Error and 429 as retryable', () => {
    expect(isRetryableUpstreamRateLimitError('Here is an example: API Error: Request rejected (429)')).toBe(
      false,
    );
  });

  test('requires API Error context and rate-limit evidence', () => {
    expect(isRetryableUpstreamRateLimitError('upstream returned HTTP 429')).toBe(false);
    expect(isRetryableUpstreamRateLimitError('API Error: upstream rejected the request')).toBe(false);
  });
});
