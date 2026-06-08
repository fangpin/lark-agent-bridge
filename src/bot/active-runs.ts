import type { AgentRun } from '../agent/types';

export type InterruptReason = 'user' | 'lifecycle';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  interruptReason?: InterruptReason;
}

function noopRun(): AgentRun {
  return {
    events: (async function* (): AsyncGenerator<never> {})(),
    async stop() {},
    async waitForExit() {
      return true;
    },
  };
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();

  register(chatId: string, run: AgentRun): RunHandle {
    const handle: RunHandle = { run, interrupted: false };
    this.handles.set(chatId, handle);
    return handle;
  }

  registerPreRun(chatId: string): RunHandle {
    const handle: RunHandle = { run: noopRun(), interrupted: false };
    this.handles.set(chatId, handle);
    return handle;
  }

  attachRun(chatId: string, handle: RunHandle, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing === handle) handle.run = run;
  }

  unregister(chatId: string, runOrHandle: AgentRun | RunHandle): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === runOrHandle || existing === runOrHandle) this.handles.delete(chatId);
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId: string, reason: InterruptReason = 'user'): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    h.interrupted = true;
    h.interruptReason = reason;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  async stopAll(reason: InterruptReason = 'user'): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    for (const h of all) {
      h.interrupted = true;
      h.interruptReason = reason;
    }
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }
}
