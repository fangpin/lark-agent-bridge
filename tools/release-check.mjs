#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

export function parseArgs(argv) {
  const opts = {
    registry: DEFAULT_REGISTRY,
    branch: 'main',
    skipRegistry: false,
    allowDirty: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--registry') {
      const value = argv[i + 1];
      if (!value) throw new Error('--registry requires a value');
      opts.registry = value;
      i += 1;
    } else if (arg === '--branch') {
      const value = argv[i + 1];
      if (!value) throw new Error('--branch requires a value');
      opts.branch = value;
      i += 1;
    } else if (arg === '--skip-registry') {
      opts.skipRegistry = true;
    } else if (arg === '--allow-dirty') {
      opts.allowDirty = true;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export function summarizeGitStatus(status) {
  const untracked = [];
  let trackedDirty = false;
  for (const line of status.split('\n')) {
    if (!line) continue;
    if (line.startsWith('?? ')) {
      untracked.push(line.slice(3));
    } else {
      trackedDirty = true;
    }
  }
  return { trackedDirty, untracked };
}

export function validatePackageVersions(pkg, lock) {
  const errors = [];
  if (!pkg?.version) errors.push('package.json version is missing');
  if (lock?.version && pkg?.version && lock.version !== pkg.version) {
    errors.push(`package-lock.json version is ${lock.version}, expected ${pkg.version}`);
  }
  const rootVersion = lock?.packages?.['']?.version;
  if (rootVersion && pkg?.version && rootVersion !== pkg.version) {
    errors.push(`package-lock root version is ${rootVersion}, expected ${pkg.version}`);
  }
  return errors;
}

export function packageSpec(name, version) {
  return `${name}@${version}`;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'] }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function usage() {
  return [
    'Usage: npm run release:check -- [--registry <url>] [--branch <name>] [--skip-registry] [--allow-dirty]',
    '',
    'Checks that the current package version is ready to publish.',
    'Run after npm version <patch|minor|major> and before npm publish.',
  ].join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const spec = packageSpec(pkg.name, pkg.version);
  const errors = validatePackageVersions(pkg, lock);

  const branch = run('git', ['branch', '--show-current']);
  if (opts.branch && branch !== opts.branch) {
    errors.push(`current branch is ${branch || '(detached)'}, expected ${opts.branch}`);
  }

  const status = summarizeGitStatus(run('git', ['status', '--porcelain']));
  if (status.trackedDirty && !opts.allowDirty) {
    errors.push('tracked worktree changes are present; commit or stash them before release');
  }

  const head = run('git', ['rev-parse', 'HEAD']);
  const upstream = run('git', ['rev-parse', `origin/${opts.branch}`]);
  if (head !== upstream) {
    errors.push(`HEAD ${head.slice(0, 7)} does not match origin/${opts.branch} ${upstream.slice(0, 7)}`);
  }

  if (!opts.skipRegistry) {
    try {
      run('npm', ['view', spec, 'version', '--registry', opts.registry]);
      errors.push(`${spec} already exists on ${opts.registry}`);
    } catch {
      // npm exits non-zero when the exact version does not exist, which is what we want.
    }
  }

  if (errors.length > 0) {
    console.error(`Release check failed for ${spec}:`);
    for (const error of errors) console.error(`- ${error}`);
    if (status.untracked.length > 0) {
      console.error(`Untracked files ignored by default: ${status.untracked.join(', ')}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Release check passed for ${spec}`);
  console.log(`Registry: ${opts.registry}`);
  if (status.untracked.length > 0) {
    console.log(`Untracked files ignored: ${status.untracked.join(', ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
