import { describe, expect, test } from 'vitest';
import { translateEvent } from '../../../src/agent/claude/stream-json';

describe('translateEvent', () => {
  test('treats upstream API rate-limit assistant text as terminal errors', () => {
    const message = 'API Error: Request rejected (429) · upstream error: {"error":{"message":"Too Many Requests","code":"-4399"}}';

    expect([
      ...translateEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: message }] },
      }),
    ]).toEqual([{ type: 'error', message }]);
  });
});
