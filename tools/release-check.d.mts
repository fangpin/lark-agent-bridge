export interface ReleaseCheckOptions {
  registry: string;
  branch: string;
  skipRegistry: boolean;
  allowDirty: boolean;
  help?: boolean;
}

export interface GitStatusSummary {
  trackedDirty: boolean;
  untracked: string[];
}

export function parseArgs(argv: string[]): ReleaseCheckOptions;
export function summarizeGitStatus(status: string): GitStatusSummary;
export function validatePackageVersions(pkg: unknown, lock: unknown): string[];
export function packageSpec(name: string, version: string): string;
