declare module '@cursor/sdk' {
  export interface RunResult {
    id: string;
    status: 'finished' | 'error' | 'cancelled';
    result?: string;
    model?: unknown;
    durationMs?: number;
    git?: unknown;
  }

  export interface SDKRun {
    readonly id: string;
    stream(): AsyncGenerator<unknown, void>;
    wait(): Promise<RunResult>;
    cancel(): Promise<void>;
  }

  export interface SDKAgent {
    readonly agentId: string;
    send(message: string): Promise<SDKRun>;
    close(): void;
    [Symbol.asyncDispose](): Promise<void>;
  }

  export class CursorAgentError extends Error {
    code?: string | number;
    status?: number;
    operation?: string;
    endpoint?: string;
    requestId?: string;
    rawMessage?: string;
    isRetryable: boolean;
  }

  export const Agent: {
    create(options: unknown): Promise<SDKAgent>;
    resume(agentId: string, options?: unknown): Promise<SDKAgent>;
  };
}
