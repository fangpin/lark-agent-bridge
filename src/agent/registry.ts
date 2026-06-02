import type { AgentAdapter } from './types';

export type AgentFactory = (key: string) => Promise<AgentAdapter>;

export class AgentRegistry {
  private readonly knownKeys: string[];
  private readonly defaultBackendKey: string;
  private readonly create: AgentFactory;
  private readonly adapters = new Map<string, Promise<AgentAdapter>>();

  constructor(keys: string[], defaultKey: string, create: AgentFactory) {
    this.knownKeys = [...keys];
    this.defaultBackendKey = this.knownKeys.includes(defaultKey) ? defaultKey : (this.knownKeys[0] ?? defaultKey);
    this.create = create;
  }

  keys(): string[] {
    return [...this.knownKeys];
  }

  defaultKey(): string {
    return this.defaultBackendKey;
  }

  has(key: string): boolean {
    return this.knownKeys.includes(key);
  }

  get(key: string): Promise<AgentAdapter> {
    if (!this.has(key)) throw new Error(`unknown backend: ${key}`);
    let adapter = this.adapters.get(key);
    if (!adapter) {
      adapter = this.create(key);
      this.adapters.set(key, adapter);
    }
    return adapter;
  }

  getDefault(): Promise<AgentAdapter> {
    return this.get(this.defaultBackendKey);
  }

  getOrDefault(key: string | undefined): Promise<AgentAdapter> {
    return this.get(key && this.has(key) ? key : this.defaultBackendKey);
  }

  async shutdown(): Promise<void> {
    const adapters = await Promise.all(this.adapters.values());
    await Promise.all(adapters.map((adapter) => adapter.shutdown?.()));
  }
}
