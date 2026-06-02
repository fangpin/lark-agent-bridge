export class CursorAgentError extends Error {
  code?: string | number;
  status?: number;
  operation?: string;
  endpoint?: string;
  requestId?: string;
  rawMessage?: string;
  isRetryable: boolean;

  constructor(message = 'Cursor agent error') {
    super(message);
    this.name = 'CursorAgentError';
    this.isRetryable = false;
  }
}

export const Agent = {
  async create(): Promise<never> {
    throw new Error('Agent.create is not implemented in the test stub');
  },
  async resume(): Promise<never> {
    throw new Error('Agent.resume is not implemented in the test stub');
  },
};
