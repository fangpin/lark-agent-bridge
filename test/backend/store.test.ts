import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BackendStore } from '../../src/backend/store';

describe('BackendStore', () => {
  test('stores and persists per-scope backend selections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'backend-store-'));
    const file = join(dir, 'backends.json');
    const store = new BackendStore(file);

    expect(store.get('chat-1')).toBeUndefined();
    store.set('chat-1', 'codex');
    await store.flush();

    const loaded = new BackendStore(file);
    await loaded.load();
    expect(loaded.get('chat-1')).toBe('codex');
  });

  test('clear removes a selected backend and persists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'backend-store-'));
    const file = join(dir, 'backends.json');
    const store = new BackendStore(file);

    store.set('chat-1', 'codex');
    expect(store.clear('chat-1')).toBe(true);
    expect(store.clear('chat-1')).toBe(false);
    await store.flush();

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ scopes: {} });
  });
});
