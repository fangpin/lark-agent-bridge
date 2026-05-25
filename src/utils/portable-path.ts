import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

export interface PortablePathOptions {
  homeDir?: string;
}

export function toPortablePath(path: string, options: PortablePathOptions = {}): string {
  const home = normalizeExisting(options.homeDir ?? homedir());
  const absolute = normalizeExisting(fromPortablePath(path, { homeDir: home }));
  const rel = relative(home, absolute);

  if (rel === '') return '~';
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  return absolute;
}

export function fromPortablePath(path: string, options: PortablePathOptions = {}): string {
  const home = resolve(options.homeDir ?? homedir());
  if (path === '~') return home;
  if (path.startsWith('~/')) return resolve(home, path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return resolve(home, path);
}

function normalizeExisting(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
