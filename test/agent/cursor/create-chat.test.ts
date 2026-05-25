import { describe, expect, test } from 'vitest';
import { parseCreateChatOutput } from '../../../src/agent/cursor/create-chat';

describe('parseCreateChatOutput', () => {
  test('parses a single uuid line', () => {
    expect(parseCreateChatOutput('013e249d-5682-4a1f-9c2d-abcdef012345\n')).toBe(
      '013e249d-5682-4a1f-9c2d-abcdef012345',
    );
  });

  test('ignores blank lines and picks the uuid', () => {
    expect(parseCreateChatOutput('\n\n013e249d-5682-4a1f-9c2d-abcdef012345\n')).toBe(
      '013e249d-5682-4a1f-9c2d-abcdef012345',
    );
  });

  test('returns undefined for non-uuid output', () => {
    expect(parseCreateChatOutput('failed\n')).toBeUndefined();
  });
});
