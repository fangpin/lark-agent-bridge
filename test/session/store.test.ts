import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SessionStore } from '../../src/session/store';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lark-agent-session-store-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SessionStore', () => {
  test('persists home-relative cwd values while exposing absolute runtime entries', async () => {
    const root = await tempRoot();
    const home = join(root, 'machine-a');
    const file = join(root, 'sessions.json');
    const store = new SessionStore(file, { homeDir: home });

    store.set('chat-1', 'claude', 'session-123', join(home, 'repos', 'bridge'));
    await store.flush();

    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      { agents?: Record<string, { cwd: string }> }
    >;
    expect(raw['chat-1']?.agents?.claude?.cwd).toBe('repos/bridge');
    expect(store.getRaw('chat-1', 'claude')?.cwd).toBe(join(home, 'repos', 'bridge'));
    expect(store.resumeFor('chat-1', join(home, 'repos', 'bridge'), 'claude')).toBe(
      'session-123',
    );
  });

  test('loads legacy flat sessions as cursor sdk sessions', async () => {
    const root = await tempRoot();
    const file = join(root, 'sessions.json');
    const currentHome = join(root, 'linux-home');
    await writeFile(
      file,
      JSON.stringify({
        'chat-1': {
          sessionId: 'session-123',
          cwd: 'repos/bridge',
          updatedAt: 123,
        },
      }),
    );

    const store = new SessionStore(file, { homeDir: currentHome });
    await store.load();

    expect(store.getRaw('chat-1', 'cursor:sdk')?.cwd).toBe(join(currentHome, 'repos', 'bridge'));
    expect(store.resumeFor('chat-1', join(currentHome, 'repos', 'bridge'), 'cursor:sdk')).toBe(
      'session-123',
    );
    expect(store.resumeFor('chat-1', join(currentHome, 'repos', 'bridge'), 'claude')).toBeUndefined();
  });

  test('normalizes symlinked home paths when reading and matching sessions', async () => {
    const root = await tempRoot();
    const realHome = join(root, 'real-home');
    const aliasHome = join(root, 'alias-home');
    const realCwd = join(realHome, 'repos', 'bridge');
    const aliasCwd = join(aliasHome, 'repos', 'bridge');
    const file = join(root, 'sessions.json');
    await mkdir(realCwd, { recursive: true });
    await symlink(realHome, aliasHome);
    const store = new SessionStore(file, { homeDir: aliasHome });

    store.set('chat-1', 'claude', 'session-123', aliasCwd);
    await store.flush();

    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      { agents?: Record<string, { cwd: string }> }
    >;
    expect(raw['chat-1']?.agents?.claude?.cwd).toBe('repos/bridge');
    expect(store.getRaw('chat-1', 'claude')?.cwd).toBe(realCwd);
    expect(store.resumeFor('chat-1', realCwd, 'claude')).toBe('session-123');
    expect(store.resumeFor('chat-1', aliasCwd, 'claude')).toBe('session-123');
  });

  test('stores separate backend sessions under one scope', async () => {
    const root = await tempRoot();
    const home = join(root, 'machine-a');
    const store = new SessionStore(join(root, 'sessions.json'), { homeDir: home });
    const cwd = join(home, 'repos', 'bridge');

    store.set('chat-1', 'cursor:sdk', 'cursor-session', cwd);
    store.set('chat-1', 'claude', 'claude-session', cwd);

    expect(store.resumeFor('chat-1', cwd, 'cursor:sdk')).toBe('cursor-session');
    expect(store.resumeFor('chat-1', cwd, 'claude')).toBe('claude-session');
  });

  test('clears one backend session while preserving other backend sessions and timeout override', async () => {
    const root = await tempRoot();
    const home = join(root, 'machine-a');
    const store = new SessionStore(join(root, 'sessions.json'), { homeDir: home });
    const cwd = join(home, 'repos', 'bridge');

    store.set('chat-1', 'cursor:sdk', 'cursor-session', cwd);
    store.set('chat-1', 'claude', 'claude-session', cwd);
    store.setIdleTimeoutMinutes('chat-1', 15);
    store.clear('chat-1', 'claude');

    expect(store.resumeFor('chat-1', cwd, 'claude')).toBeUndefined();
    expect(store.resumeFor('chat-1', cwd, 'cursor:sdk')).toBe('cursor-session');
    expect(store.getIdleTimeoutMinutes('chat-1')).toBe(15);
  });
});
