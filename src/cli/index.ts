import { Command } from 'commander';
import pkg from '../../package.json';
import { runMigrate } from './commands/migrate';
import { runPs, runStopCli } from './commands/ps';
import {
  runSecretsGet,
  runSecretsList,
  runSecretsRemove,
  runSecretsSet,
} from './commands/secrets';
import { runStart } from './commands/start';

const program = new Command();

program
  .name('lark-agent-bridge')
  .description('Bridge Feishu/Lark messenger with local CLI coding agents')
  .version(pkg.version, '-v, --version');

program
  .command('start')
  .description('Start the bot (runs first-run wizard if bot config is missing)')
  .option('-c, --config <path>', 'path to config file')
  .action(async (opts: { config?: string }) => {
    await runStart(opts);
  });

program
  .command('migrate')
  .description(
    'Migrate from pre-0.1.11 setup: move ~/.config/lark-channel-bridge/* and ' +
      '~/.cache/lark-channel-bridge/* into ~/.lark-channel/, and rewrite ' +
      'config.json from { app } to { accounts.app }',
  )
  .option('-c, --config <path>', 'path to config file (after migration)')
  .action(async (opts: { config?: string }) => {
    await runMigrate(opts);
  });

program
  .command('ps')
  .description('List running lark-agent-bridge start processes (this machine)')
  .action(() => {
    runPs();
  });

program
  .command('stop <target>')
  .description('Stop a running start process by short id or list index (SIGTERM, then SIGKILL after 2s)')
  .action(async (target: string) => {
    await runStopCli(target);
  });

const secrets = program
  .command('secrets')
  .description('Manage the bridge\'s encrypted secret keystore (~/.lark-channel/secrets.enc)');

secrets
  .command('get')
  .description('Exec-provider protocol: read JSON request from stdin, write JSON response to stdout. Used by lark-cli config bind --source lark-channel.')
  .action(async () => {
    await runSecretsGet();
  });

secrets
  .command('set')
  .description('Encrypt and store a secret. Prompts without echoing.')
  .option('--app-id <id>', 'App ID → keystore id app-<id> (Feishu App Secret)')
  .option('--id <id>', 'Keystore id (e.g. cursor-api-key for Cursor API Key)')
  .action(async (opts: { appId?: string; id?: string }) => {
    if (!opts.appId && !opts.id) {
      console.error('需要 --app-id 或 --id');
      process.exit(1);
    }
    await runSecretsSet(opts.appId, opts.id);
  });

secrets
  .command('list')
  .description('List the IDs of secrets in the encrypted keystore (no secrets shown)')
  .action(async () => {
    await runSecretsList();
  });

secrets
  .command('remove')
  .description('Delete an entry from the encrypted keystore')
  .option('--app-id <id>', 'App ID → keystore id app-<id>')
  .option('--id <id>', 'Keystore id (e.g. cursor-api-key)')
  .action(async (opts: { appId?: string; id?: string }) => {
    if (!opts.appId && !opts.id) {
      console.error('需要 --app-id 或 --id');
      process.exit(1);
    }
    await runSecretsRemove(opts.appId, opts.id);
  });

program
  .command('status')
  .description('Show runtime status (WS connection, agent availability)')
  .action(async () => {
    console.log('status: not implemented yet');
  });

program
  .command('doctor')
  .description('Check config, claude CLI, and required platform scopes')
  .action(async () => {
    console.log('doctor: not implemented yet');
  });

program
  .command('handover <text>')
  .description('Hand over a terminal Claude Code session to Feishu')
  .action(async (_text: string) => {
    console.log('handover: not implemented yet');
  });

program
  .command('workspace <action>')
  .description('Manage saved workspaces: list | add | remove | default')
  .action(async (_action: string) => {
    console.log('workspace: not implemented yet');
  });

program
  .command('service <action> <type>')
  .description('Install or uninstall autostart service: launchd | systemd')
  .action(async (_action: string, _type: string) => {
    console.log('service: not implemented yet');
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
