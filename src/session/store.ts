import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
      if (!agentEntry) return undefined;
      return {
        sessionId: agentEntry.sessionId,
        cwd: fromPortablePath(agentEntry.cwd, this.pathOptions),
        updatedAt: agentEntry.updatedAt,
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
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      this.saving = Promise.resolve();
    } catch (err) {
      log.fail('session', err, { step: 'persist' });
      this.saving = Promise.resolve();
    }
  }
}
