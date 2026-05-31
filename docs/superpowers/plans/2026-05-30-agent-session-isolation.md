# Agent Session Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and resume chat sessions separately for Claude, Cursor SDK, and Cursor CLI so startup with one backend never loads another backend's session.

**Architecture:** Add a stable `sessionKey` to each agent adapter and make `SessionStore` keep per-scope session records under `agents[sessionKey]`. Existing flat session files are migrated in memory as `cursor:sdk`, while timeout overrides remain scope-level preferences.

**Tech Stack:** TypeScript, Node.js 20 ESM, Vitest, existing `SessionStore`, `AgentAdapter`, command, channel, and comment flow modules.

---

## File Structure

- Modify `src/agent/types.ts`: add `sessionKey` to the adapter interface.
- Modify `src/agent/claude/adapter.ts`: expose `sessionKey = 'claude'`.
- Modify `src/agent/cursor/adapter.ts`: expose `sessionKey` based on runtime (`cursor:sdk` or `cursor:cli`).
- Modify `src/session/store.ts`: introduce per-agent session storage, legacy flat-entry migration, and agent-aware `resumeFor`, `set`, `getRaw`, and `clear` operations.
- Modify `src/session/ensure-resume.ts`: use `agent.sessionKey` for resume, clear, and set.
- Modify `src/bot/channel.ts`: pass `agent.sessionKey` when looking up and writing run sessions.
- Modify `src/bot/comments.ts`: pass `agent.sessionKey` for synthetic doc-comment sessions.
- Modify `src/commands/index.ts`: pass `agent.sessionKey` for `/new`, `/cd`, `/ws use`, `/resume`, and `/status` session operations.
- Modify `test/session/store.test.ts`: cover new store shape, legacy migration, per-agent isolation, and targeted clear.
- Modify `test/session/ensure-resume.test.ts`: cover current-agent compatibility and replacement behavior.
- Modify `test/bot/channel.test.ts` only if existing mocks fail type-check after adding `sessionKey`.

## Task 1: Add adapter session keys

**Files:**
- Modify: `src/agent/types.ts:65-75`
- Modify: `src/agent/claude/adapter.ts:100-103`
- Modify: `src/agent/cursor/adapter.ts:26-33`

- [ ] **Step 1: Add the interface field**

In `src/agent/types.ts`, change the start of `AgentAdapter` to:

```ts
export interface AgentAdapter {
  readonly id: string;
  readonly sessionKey: string;
  readonly displayName: string;
  readonly commandLabel: string;
  isAvailable(): Promise<boolean>;
  run(opts: AgentRunOptions): AgentRun;
  /** Optional: pre-create a backend session id (Cursor CLI create-chat or SDK agent). */
  prepareSession?(cwd: string, scope?: string): Promise<string | undefined>;
  /** Optional: reject persisted session ids from another runtime/version before resume. */
  canResumeSession?(sessionId: string): boolean;
  /** Optional: drop a pooled SDK worker for a bridge scope (/new, /cd). */
  evictScope?(scope: string, cwd?: string): Promise<void>;
  /** Optional: inspect pooled worker health for diagnostics. */
  workerSnapshots?(): WorkerSnapshot[];
  /** Optional: release pooled SDK workers on bridge shutdown. */
  shutdown?(): Promise<void>;
}
```

- [ ] **Step 2: Add Claude session key**

In `src/agent/claude/adapter.ts`, change the class fields to:

```ts
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly sessionKey = 'claude';
  readonly displayName = 'Claude Code';

  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly claudeArgsOption?: string;
```

- [ ] **Step 3: Add Cursor session key**

In `src/agent/cursor/adapter.ts`, add a readonly field and set it in the constructor:

```ts
export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor';
  readonly displayName = 'Cursor Agent';
  readonly sessionKey: string;

  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly runtime: 'sdk' | 'cli';
```

Then in the constructor, immediately after `this.runtime = opts.runtime ?? 'cli';`, add:

```ts
this.sessionKey = `cursor:${this.runtime}`;
```

- [ ] **Step 4: Run typecheck and note expected failures**

Run:

```bash
npm run typecheck
```

Expected: it may fail because test mocks implementing `AgentAdapter` do not yet include `sessionKey`. Do not fix mocks in this task unless the only failures are in the files touched above.

- [ ] **Step 5: Commit**

```bash
git add src/agent/types.ts src/agent/claude/adapter.ts src/agent/cursor/adapter.ts
git commit -m "feat: add agent session keys"
```

## Task 2: Redesign SessionStore with per-agent sessions

**Files:**
- Modify: `src/session/store.ts`
- Modify: `test/session/store.test.ts`

- [ ] **Step 1: Replace store tests with expected behavior**

Update `test/session/store.test.ts` to this complete file:

```ts
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
```

- [ ] **Step 2: Run store tests to verify failure**

Run:

```bash
npm test -- test/session/store.test.ts
```

Expected: FAIL with TypeScript or runtime errors because `SessionStore.set` and `resumeFor` still use the old signatures.

- [ ] **Step 3: Replace SessionStore implementation**

Update `src/session/store.ts` to this complete file:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { fromPortablePath, toPortablePath, type PortablePathOptions } from '../utils/portable-path';

const LEGACY_SESSION_KEY = 'cursor:sdk';

export interface AgentSessionEntry {
  sessionId: string;
  cwd: string;
  updatedAt: number;
}

export interface SessionEntry {
  updatedAt: number;
  agents?: Record<string, AgentSessionEntry>;
  idleTimeoutMinutes?: number;
}

export interface RuntimeSessionEntry {
  sessionId?: string;
  cwd?: string;
  updatedAt: number;
  agents?: Record<string, AgentSessionEntry>;
  idleTimeoutMinutes?: number;
}

type SessionMap = Record<string, SessionEntry>;

type RawSessionEntry = Partial<SessionEntry> & {
  sessionId?: unknown;
  cwd?: unknown;
  updatedAt?: unknown;
  idleTimeoutMinutes?: unknown;
  agents?: unknown;
};

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly pathOptions: PortablePathOptions;

  constructor(path: string = paths.sessionsFile, pathOptions: PortablePathOptions = {}) {
    this.path = path;
    this.pathOptions = pathOptions;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, RawSessionEntry>;
      this.data = {};
      for (const [chatId, entry] of Object.entries(raw)) {
        const normalized = this.normalizeEntry(entry);
        if (normalized) this.data[chatId] = normalized;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  resumeFor(chatId: string, cwd: string, sessionKey: string): string | undefined {
    const entry = this.data[chatId]?.agents?.[sessionKey];
    if (!entry) return undefined;
    const storedCwd = fromPortablePath(entry.cwd, this.pathOptions);
    const requestedCwd = fromPortablePath(cwd, this.pathOptions);
    if (storedCwd !== requestedCwd) return undefined;
    return entry.sessionId;
  }

  getRaw(chatId: string, sessionKey?: string): RuntimeSessionEntry | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (sessionKey) {
      const agentEntry = entry.agents?.[sessionKey];
      return {
        ...(agentEntry
          ? {
              sessionId: agentEntry.sessionId,
              cwd: fromPortablePath(agentEntry.cwd, this.pathOptions),
              updatedAt: agentEntry.updatedAt,
            }
          : { updatedAt: entry.updatedAt }),
        ...(entry.idleTimeoutMinutes !== undefined
          ? { idleTimeoutMinutes: entry.idleTimeoutMinutes }
          : {}),
      };
    }
    return {
      updatedAt: entry.updatedAt,
      ...(entry.agents ? { agents: this.runtimeAgents(entry.agents) } : {}),
      ...(entry.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: entry.idleTimeoutMinutes }
        : {}),
    };
  }

  set(chatId: string, sessionKey: string, sessionId: string, cwd: string): void {
    const prev = this.data[chatId];
    const agents = { ...(prev?.agents ?? {}) };
    agents[sessionKey] = {
      sessionId,
      cwd: toPortablePath(cwd, this.pathOptions),
      updatedAt: Date.now(),
    };
    this.data[chatId] = {
      updatedAt: Date.now(),
      agents,
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
    };
    this.schedulePersist();
  }

  clear(chatId: string, sessionKey?: string): void {
    if (!(chatId in this.data)) return;
    if (!sessionKey) {
      delete this.data[chatId];
      this.schedulePersist();
      return;
    }
    const prev = this.data[chatId];
    const agents = { ...(prev.agents ?? {}) };
    if (!(sessionKey in agents)) return;
    delete agents[sessionKey];
    if (Object.keys(agents).length === 0 && prev.idleTimeoutMinutes === undefined) {
      delete this.data[chatId];
    } else {
      this.data[chatId] = {
        updatedAt: Date.now(),
        ...(Object.keys(agents).length > 0 ? { agents } : {}),
        ...(prev.idleTimeoutMinutes !== undefined
          ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
          : {}),
      };
    }
    this.schedulePersist();
  }

  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      updatedAt: Date.now(),
      ...(prev?.agents ? { agents: prev.agents } : {}),
      idleTimeoutMinutes: clamped,
    };
    this.schedulePersist();
  }

  clearIdleTimeoutOverride(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private normalizeEntry(entry: RawSessionEntry | undefined): SessionEntry | undefined {
    if (!entry || typeof entry.updatedAt !== 'number') return undefined;
    const idleTimeoutMinutes =
      typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
    const agents = this.normalizeAgents(entry);
    if (Object.keys(agents).length === 0 && idleTimeoutMinutes === undefined) return undefined;
    return {
      updatedAt: entry.updatedAt,
      ...(Object.keys(agents).length > 0 ? { agents } : {}),
      ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
    };
  }

  private normalizeAgents(entry: RawSessionEntry): Record<string, AgentSessionEntry> {
    const agents: Record<string, AgentSessionEntry> = {};
    if (entry.agents && typeof entry.agents === 'object') {
      for (const [key, value] of Object.entries(entry.agents as Record<string, unknown>)) {
        const normalized = this.normalizeAgentEntry(value);
        if (normalized) agents[key] = normalized;
      }
    }
    if (typeof entry.sessionId === 'string' && typeof entry.cwd === 'string') {
      agents[LEGACY_SESSION_KEY] = {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
      };
    }
    return agents;
  }

  private normalizeAgentEntry(value: unknown): AgentSessionEntry | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.sessionId !== 'string') return undefined;
    if (typeof record.cwd !== 'string') return undefined;
    if (typeof record.updatedAt !== 'number') return undefined;
    return {
      sessionId: record.sessionId,
      cwd: record.cwd,
      updatedAt: record.updatedAt,
    };
  }

  private runtimeAgents(
    agents: Record<string, AgentSessionEntry>,
  ): Record<string, AgentSessionEntry> {
    return Object.fromEntries(
      Object.entries(agents).map(([key, entry]) => [
        key,
        { ...entry, cwd: fromPortablePath(entry.cwd, this.pathOptions) },
      ]),
    );
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}
```

- [ ] **Step 4: Run store tests**

Run:

```bash
npm test -- test/session/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session/store.ts test/session/store.test.ts
git commit -m "feat: store sessions by agent backend"
```

## Task 3: Make ensureResumeSession agent-aware

**Files:**
- Modify: `src/session/ensure-resume.ts`
- Modify: `test/session/ensure-resume.test.ts`

- [ ] **Step 1: Replace ensure-resume tests**

Update `test/session/ensure-resume.test.ts` to this complete file:

```ts
import { describe, expect, test, vi } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types';
import { ensureResumeSession } from '../../src/session/ensure-resume';
import { SessionStore } from '../../src/session/store';

function mockAgent(
  sessionKey: string,
  prepare?: (cwd: string) => Promise<string | undefined>,
  canResumeSession?: (sessionId: string) => boolean,
): AgentAdapter {
  return {
    id: sessionKey.split(':')[0] ?? sessionKey,
    sessionKey,
    displayName: sessionKey,
    commandLabel: sessionKey,
    isAvailable: async () => true,
    run: () => {
      throw new Error('not used');
    },
    prepareSession: prepare,
    canResumeSession,
  };
}

describe('ensureResumeSession', () => {
  test('returns existing session for the active agent without calling prepareSession', async () => {
    const store = new SessionStore('/tmp/unused-sessions.json');
    store.set('scope-1', 'cursor:sdk', 'sess-existing', '/tmp/project');
    const prepare = vi.fn(async () => 'sess-new');
    const agent = mockAgent('cursor:sdk', prepare);

    const id = await ensureResumeSession(agent, store, 'scope-1', '/tmp/project');

    expect(id).toBe('sess-existing');
    expect(prepare).not.toHaveBeenCalled();
  });

  test('does not return another agent backend session', async () => {
    const store = new SessionStore('/tmp/unused-sessions-2.json');
    store.set('scope-2', 'cursor:sdk', 'cursor-session', '/tmp/project');
    const agent = mockAgent('claude', async () => 'claude-session');

    const id = await ensureResumeSession(agent, store, 'scope-2', '/tmp/project');

    expect(id).toBe('claude-session');
    expect(store.resumeFor('scope-2', '/tmp/project', 'cursor:sdk')).toBe('cursor-session');
    expect(store.resumeFor('scope-2', '/tmp/project', 'claude')).toBe('claude-session');
  });

  test('pre-creates and stores a session when missing for active agent', async () => {
    const store = new SessionStore('/tmp/unused-sessions-3.json');
    const agent = mockAgent('cursor:sdk', async () => 'sess-new');

    const id = await ensureResumeSession(agent, store, 'scope-3', '/tmp/project');

    expect(id).toBe('sess-new');
    expect(store.resumeFor('scope-3', '/tmp/project', 'cursor:sdk')).toBe('sess-new');
  });

  test('replaces only the active agent session that the agent cannot resume', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SessionStore('/tmp/unused-sessions-4.json');
    store.set('scope-4', 'cursor:sdk', 'legacy-cli-session', '/tmp/project');
    store.set('scope-4', 'claude', 'claude-session', '/tmp/project');
    const agent = mockAgent('cursor:sdk', async () => 'agent-sdk-session', (sessionId) =>
      sessionId.startsWith('agent-'),
    );

    try {
      const id = await ensureResumeSession(agent, store, 'scope-4', '/tmp/project');

      expect(id).toBe('agent-sdk-session');
      expect(store.resumeFor('scope-4', '/tmp/project', 'cursor:sdk')).toBe('agent-sdk-session');
      expect(store.resumeFor('scope-4', '/tmp/project', 'claude')).toBe('claude-session');
    } finally {
      warn.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run ensure-resume tests to verify failure**

Run:

```bash
npm test -- test/session/ensure-resume.test.ts
```

Expected: FAIL because `ensureResumeSession` still calls old `SessionStore` signatures.

- [ ] **Step 3: Update ensureResumeSession**

Replace `src/session/ensure-resume.ts` with:

```ts
import type { AgentAdapter } from '../agent/types';
import { log } from '../core/logger';
import type { SessionStore } from './store';

export async function ensureResumeSession(
  agent: AgentAdapter,
  sessions: SessionStore,
  scope: string,
  cwd: string,
): Promise<string | undefined> {
  const sessionKey = agent.sessionKey;
  const existing = sessions.resumeFor(scope, cwd, sessionKey);
  if (existing) {
    if (agent.canResumeSession?.(existing) === false) {
      log.warn('session', 'resume-incompatible', { scope, cwd, sessionId: existing, sessionKey });
      sessions.clear(scope, sessionKey);
    } else {
      return existing;
    }
  }
  if (!agent.prepareSession) return undefined;

  const sessionId = await agent.prepareSession(cwd, scope);
  if (!sessionId) {
    log.warn('session', 'precreate-failed', { scope, cwd, sessionKey });
    return undefined;
  }

  sessions.set(scope, sessionKey, sessionId, cwd);
  log.info('session', 'precreate', { scope, cwd, sessionId, sessionKey });
  return sessionId;
}
```

- [ ] **Step 4: Run ensure-resume tests**

Run:

```bash
npm test -- test/session/ensure-resume.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session/ensure-resume.ts test/session/ensure-resume.test.ts
git commit -m "feat: resume sessions by agent key"
```

## Task 4: Update runtime session call sites

**Files:**
- Modify: `src/bot/channel.ts:578-606,1039-1061`
- Modify: `src/bot/comments.ts:114-141`
- Modify: `src/commands/index.ts:269-282,336-358,402-417,445-479`
- Modify: tests only if TypeScript identifies mocks lacking `sessionKey`

- [ ] **Step 1: Update run batch resume logic**

In `src/bot/channel.ts`, replace the block beginning `const cwd = workspaces.cwdFor(scope) ?? homedir();` through the `resume-precreate` log with:

```ts
  const cwd = workspaces.cwdFor(scope) ?? homedir();
  const sessionKey = agent.sessionKey;
  let resumeFrom = sessions.resumeFor(scope, cwd, sessionKey);
  if (resumeFrom && agent.canResumeSession?.(resumeFrom) === false) {
    log.warn('session', 'resume-incompatible', { sessionId: resumeFrom, cwd, sessionKey });
    sessions.clear(scope, sessionKey);
    resumeFrom = undefined;
  }
  if (resumeFrom) {
    log.info('session', 'resume', { sessionId: resumeFrom, cwd, sessionKey });
  } else {
    const stale = sessions.getRaw(scope, sessionKey);
    if (stale?.cwd && stale.cwd !== cwd) {
      log.info('session', 'stale-cleared', { staleCwd: stale.cwd, newCwd: cwd, sessionKey });
      sessions.clear(scope, sessionKey);
    } else {
      log.info('session', 'fresh', { cwd, sessionKey });
    }
    resumeFrom = await withTimeout(
      'session.precreate',
      SESSION_PRECREATE_TIMEOUT_MS,
      ensureResumeSession(agent, sessions, scope, cwd),
    ).catch((err) => {
      log.fail('session', err, { cwd, sessionKey, fallback: 'run-without-precreated-session' });
      return undefined;
    });
    if (resumeFrom) {
      log.info('session', 'resume-precreate', { sessionId: resumeFrom, cwd, sessionKey });
    }
  }
```

- [ ] **Step 2: Update channel stream session writes**

In `src/bot/channel.ts`, inside `processAgentStream`, add a local `sessionKey` near the start:

```ts
  let state: RunState = startState ?? createInitialState();
  const sessionKey = handle.agent.sessionKey;
```

If `RunHandle` does not expose `agent`, do not add this line. Instead change `processAgentStream` signature to accept `sessionKey: string` after `cwd`, update its three call sites in `runAgentBatch` to pass `agent.sessionKey`, and use that argument for writes. The resulting signature should be:

```ts
export async function processAgentStream(
  handle: RunHandle,
  sessions: SessionStore,
  scope: string,
  cwd: string,
  sessionKey: string,
  idleTimeoutMs: number | undefined,
  flush: (state: RunState) => Promise<void>,
  postDoneExitGraceMs = POST_DONE_EXIT_GRACE_MS,
  startState?: RunState,
): Promise<RunState> {
```

Then replace both session writes in `processAgentStream`:

```ts
sessions.set(scope, sessionKey, evt.sessionId, effectiveCwd);
log.info('session', 'set', { sessionId: evt.sessionId, sessionKey });
```

and:

```ts
sessions.set(scope, sessionKey, evt.sessionId, cwd);
log.info('session', 'set', { sessionId: evt.sessionId, sessionKey });
```

- [ ] **Step 3: Update comment sessions**

In `src/bot/comments.ts`, replace the system event session write with:

```ts
          if (e.sessionId) {
            const effectiveCwd = e.cwd ?? cwd;
            sessions.set(synthChatId, agent.sessionKey, e.sessionId, effectiveCwd);
          }
```

The `ensureResumeSession(agent, sessions, synthChatId, cwd)` call stays unchanged because Task 3 made it agent-aware.

- [ ] **Step 4: Update command session operations**

In `src/commands/index.ts`, change these calls:

```ts
ctx.sessions.clear(ctx.scope);
```

when used by `/new`, `/cd`, and `/ws use` to:

```ts
ctx.sessions.clear(ctx.scope, ctx.agent.sessionKey);
```

Change `/resume use` in `applyResume` from:

```ts
ctx.sessions.set(ctx.scope, sessionId, cwd);
```

to:

```ts
ctx.sessions.set(ctx.scope, ctx.agent.sessionKey, sessionId, cwd);
```

Change `/resume` current-session lookup from:

```ts
const currentSession = ctx.sessions.getRaw(ctx.scope);
```

to:

```ts
const currentSession = ctx.sessions.getRaw(ctx.scope, ctx.agent.sessionKey);
```

Change `/status` from:

```ts
const sess = ctx.sessions.getRaw(ctx.scope);
```

to:

```ts
const sess = ctx.sessions.getRaw(ctx.scope, ctx.agent.sessionKey);
```

- [ ] **Step 5: Run typecheck to find missed call sites**

Run:

```bash
npm run typecheck
```

Expected: either PASS or errors listing old `SessionStore` signatures and `AgentAdapter` mocks. Update only the listed call sites/mocks by adding `sessionKey` and using the new signatures.

- [ ] **Step 6: Run affected tests**

Run:

```bash
npm test -- test/session/store.test.ts test/session/ensure-resume.test.ts test/bot/channel.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/bot/channel.ts src/bot/comments.ts src/commands/index.ts test/bot/channel.test.ts
git commit -m "feat: isolate runtime session operations by agent"
```

If `test/bot/channel.test.ts` was not changed, omit it from `git add`.

## Task 5: Update docs and final verification

**Files:**
- Modify: `README.md:120-123,149-181`
- Modify: `README.zh.md` matching session/backend sections if present
- Modify: `AGENTS.md:70-74`

- [ ] **Step 1: Update README session file description**

In `README.md`, change the `~/.lark-channel/sessions.json` row to mention backend isolation:

```md
| `~/.lark-channel/sessions.json` | Agent session ids + cwd per chat / topic, isolated by backend/runtime (+ optional `/timeout` override) |
```

- [ ] **Step 2: Update README backend note**

Add this paragraph after the Cursor backend configuration section:

```md
Sessions are isolated by backend/runtime. A chat can keep separate Claude, Cursor SDK, and Cursor CLI sessions for the same cwd; the bridge resumes only the session matching the backend configured at startup. Existing pre-isolation session files are treated as Cursor SDK sessions during migration.
```

- [ ] **Step 3: Update README.zh.md if it has the same sections**

If `README.zh.md` contains the storage table, update the sessions row to:

```md
| `~/.lark-channel/sessions.json` | 每个 chat / topic 的 agent session id + cwd，按后端/runtime 隔离（以及可选的 `/timeout` 覆盖） |
```

If `README.zh.md` contains Cursor backend setup, add:

```md
Session 会按后端/runtime 隔离。同一个 chat 在同一 cwd 下可以分别保留 Claude、Cursor SDK、Cursor CLI 的会话；bridge 启动时只会恢复当前配置后端对应的 session。隔离功能上线前的旧 session 文件会按 Cursor SDK session 迁移。
```

- [ ] **Step 4: Update AGENTS session guidance**

In `AGENTS.md`, add this bullet under `## Session And Workspace Persistence`:

```md
- Session ids are isolated by `AgentAdapter.sessionKey` (`claude`, `cursor:sdk`, `cursor:cli`). Legacy flat `sessions.json` entries are treated as `cursor:sdk`; do not resume or clear another backend's session unless the user explicitly asks for a full reset.
```

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: both PASS.

- [ ] **Step 6: Inspect git diff**

Run:

```bash
git diff --stat
git diff -- src/session/store.ts src/session/ensure-resume.ts src/bot/channel.ts src/commands/index.ts
```

Expected: diff shows only session isolation changes and docs updates. No runtime state, credentials, `dist`, or `node_modules` files should be staged.

- [ ] **Step 7: Commit docs and verification changes**

```bash
git add README.md README.zh.md AGENTS.md
git commit -m "docs: document backend-isolated sessions"
```

If `README.zh.md` does not contain matching sections and was not changed, omit it from `git add`.
