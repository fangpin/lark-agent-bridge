import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

interface BackendData {
  scopes: Record<string, string>;
}

export class BackendStore {
  private data: BackendData = { scopes: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = join(paths.appDir, 'backends.json')) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<BackendData>;
      this.data = { scopes: parsed.scopes ?? {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  get(scope: string): string | undefined {
    return this.data.scopes[scope];
  }

  set(scope: string, backend: string): void {
    this.data.scopes[scope] = backend;
    this.schedulePersist();
  }

  clear(scope: string): boolean {
    if (!(scope in this.data.scopes)) return false;
    delete this.data.scopes[scope];
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      })
      .catch((err: unknown) => {
        log.fail('backend-store', err, { step: 'persist' });
      });
  }
}
