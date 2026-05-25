import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { fromPortablePath, toPortablePath, type PortablePathOptions } from '../utils/portable-path';

interface WorkspaceData {
  chats: Record<string, { cwd: string }>;
  named: Record<string, string>;
}

export class WorkspaceStore {
  private data: WorkspaceData = { chats: {}, named: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly pathOptions: PortablePathOptions;

  constructor(path: string = paths.workspacesFile, pathOptions: PortablePathOptions = {}) {
    this.path = path;
    this.pathOptions = pathOptions;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<WorkspaceData>;
      this.data = {
        chats: parsed.chats ?? {},
        named: parsed.named ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  cwdFor(chatId: string): string | undefined {
    const cwd = this.data.chats[chatId]?.cwd;
    return cwd ? fromPortablePath(cwd, this.pathOptions) : undefined;
  }

  setCwd(chatId: string, cwd: string): void {
    this.data.chats[chatId] = { cwd: toPortablePath(cwd, this.pathOptions) };
    this.schedulePersist();
  }

  listNamed(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.data.named).map(([name, cwd]) => [
        name,
        fromPortablePath(cwd, this.pathOptions),
      ]),
    );
  }

  getNamed(name: string): string | undefined {
    const cwd = this.data.named[name];
    return cwd ? fromPortablePath(cwd, this.pathOptions) : undefined;
  }

  saveNamed(name: string, cwd: string): void {
    this.data.named[name] = toPortablePath(cwd, this.pathOptions);
    this.schedulePersist();
  }

  removeNamed(name: string): boolean {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name];
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
        log.fail('workspace', err, { step: 'persist' });
      });
  }
}
