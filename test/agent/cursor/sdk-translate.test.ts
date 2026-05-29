import { describe, expect, test } from 'vitest';
import { translateSdkMessage } from '../../../src/agent/cursor/sdk-translate';

describe('translateSdkMessage', () => {
  test('translates SDK status messages into progress events', () => {
    expect([...translateSdkMessage({ type: 'status', status: 'CREATING' })]).toEqual([
      { type: 'progress', phase: 'starting', label: '正在创建 Agent' },
    ]);

    expect([
      ...translateSdkMessage({
        type: 'status',
        status: 'RUNNING',
        text: 'Planning next step',
      }),
    ]).toEqual([{ type: 'progress', phase: 'thinking', label: 'Planning next step' }]);
  });

  test('translates SDK task messages into progress events', () => {
    expect([...translateSdkMessage({ type: 'task', text: 'Searching files' })]).toEqual([
      { type: 'progress', phase: 'thinking', label: 'Searching files' },
    ]);
  });
});
