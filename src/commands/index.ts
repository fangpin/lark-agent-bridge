import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentRegistry } from '../agent/registry';
import type { AgentAdapter } from '../agent/types';
import type { BackendStore } from '../backend/store';
import type { ActiveRuns } from '../bot/active-runs';
import type { PendingQueue } from '../bot/pending-queue';
import type { PersistentQueue } from '../bot/persistent-queue';
import type { RunHistory } from '../bot/run-history';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../card/account-cards';
import { configCancelledCard, configFormCard, configSavedCard } from '../card/config-card';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import { helpCard, resumeCard, runDetailCard, runsCard, setupDiagnosticsCard, statusCard, workspacesCard } from '../card/templates';
import type { AppConfig, MessageReplyMode, TenantBrand } from '../config/schema';
import {
  getAgentStopGraceMs,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  getWorktreeBranchPrefix,
  isAdmin,
  secretKeyForApp,
} from '../config/schema';
import { setSecret } from '../config/keystore';
import { buildEncryptedAccountConfig, saveConfig } from '../config/store';
import { log, readRecentLogs, sanitizeLogsForDoctor } from '../core/logger';
import { runSetupDiagnostics } from '../doctor/setup';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { formatRelTime, listRecentSessions } from '../session/history';
import { ensureResumeSession } from '../session/ensure-resume';
import { isAlive, readAndPrune, resolveTarget, sameAppOthers } from '../runtime/registry';
import type { SessionStore } from '../session/store';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { backendChatName, backendLabel, createBoundChat, nameWithBackend, renameChatForBackend } from '../bot/group';
import {
  createGitWorktree,
  inspectWorktreeClearTarget,
  removeGitWorktreeAndBranch,
  validateWorktreeName,
  WorktreeClearError,
  type WorktreeClearTarget,
} from '../git/worktree';
import { removeLocalAgentHistory } from '../session/local-history';
import { sendCompletionCheckMessage } from '../bot/completion-check';

export interface Controls {
  /** Restart the bridge in-process: disconnect WS, kill claude runs, reload
   * config, reconnect with the new credentials. */
  restart(): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / active-run). Workspace cwd is keyed separately via
   * `workspaceScope(ctx)`, so a topic group shares one cwd across topics.
   * All handlers should read/write session / activeRuns through this —
   * never through `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  agentRegistry?: AgentRegistry;
  backendStore?: BackendStore;
  backendKey: string;
  activeRuns: ActiveRuns;
  pending?: PendingQueue;
  persistentQueue?: PersistentQueue;
  runHistory?: RunHistory;
  controls: Controls;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;
interface ParsedCommand {
  cmd: string;
  args: string;
}

function workspaceScope(ctx: Pick<CommandContext, 'chatMode' | 'msg' | 'scope'>): string {
  return ctx.msg.threadId ? ctx.msg.chatId : ctx.scope;
}

function workspaceCwd(ctx: Pick<CommandContext, 'chatMode' | 'msg' | 'scope' | 'workspaces'>): string | undefined {
  return ctx.workspaces.cwdFor(workspaceScope(ctx));
}

function effectiveCwd(ctx: Pick<CommandContext, 'chatMode' | 'msg' | 'scope' | 'workspaces'>): string {
  return workspaceCwd(ctx) ?? homedir();
}

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
  '/clear': handleClear,
  '/cd': handleCd,
  '/ws': handleWs,
  '/resume': handleResume,
  '/status': handleStatus,
  '/runs': handleRuns,
  '/backend': handleBackend,
  '/doc': handleDoc,
  '/help': handleHelp,
  '/account': handleAccount,
  '/config': handleConfig,
  '/stop': handleStop,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/workers': handleWorkers,
  '/retry': handleRetry,
  '/shell': handleShell,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated on the configured admin allowlist;
 * empty list = no restriction (every allowed user can run them — see
 * `isAdmin` in config/schema).
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  '/config',
  '/clear',
  '/exit',
  '/reconnect',
  '/doctor',
  '/backend',
  '/doc',
  '/workers',
  '/shell',
  '/cd',
  '/ws',
]);

function isAdminCommand(cmd: string, args = ''): boolean {
  const normalized = cmd.startsWith('/') ? cmd : `/${cmd}`;
  if (normalized === '/new') {
    const trimmedArgs = args.trim();
    return trimmedArgs === 'worktree' || trimmedArgs.startsWith('worktree ');
  }
  return ADMIN_COMMANDS.has(normalized);
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const parsed = parseCommandText(ctx.msg.content);
  if (!parsed) return false;
  const h = handlers[parsed.cmd];
  if (!h) return false;
  if (isAdminCommand(parsed.cmd, parsed.args) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info('command', 'admin-deny', {
      cmd: parsed.cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  try {
    await h(parsed.args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: parsed.cmd });
  }
  return true;
}

export function parseCommandText(content: string): ParsedCommand | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  return { cmd, args: parts.slice(1).join(' ') };
}

export function isStopCommandText(content: string): boolean {
  return parseCommandText(content)?.cmd === '/stop';
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (isAdminCommand(name, args) && !isAdmin(ctx.controls.cfg, ctx.msg.senderId)) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    // Card actions can't reply naturally (the `msg` is synthesized); the
    // click is silently denied. The button only renders for users who got
    // the original admin card in the first place, so this is an edge case.
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: name });
  }
  return true;
}

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
function replyOptions(ctx: CommandContext): { replyTo: string; replyInThread?: true } {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.msg.threadId ? { replyInThread: true as const } : {}),
  };
}

async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, replyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
  }
}

async function replyCard(ctx: CommandContext, card: object): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { card }, replyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'reply-card' });
  }
}

interface CommandStatusCardOpts {
  title: string;
  status: 'success' | 'warning' | 'info' | 'error';
  lines: string[];
}

function commandStatusCard(opts: CommandStatusCardOpts): object {
  const statusMeta = {
    success: { icon: '✅' },
    warning: { icon: '⚠️' },
    info: { icon: 'ℹ️' },
    error: { icon: '❌' },
  }[opts.status];
  const body = opts.lines.filter(Boolean).join('\n\n');
  return {
    schema: '2.0',
    config: {
      summary: { content: opts.title },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `**${statusMeta.icon} ${opts.title}**${body ? `\n\n${body}` : ''}`,
        },
      ],
    },
  };
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

function resolveCdInput(input: string, baseCwd: string): string {
  if (input.startsWith('/') || input.startsWith('~')) return expandTilde(input);
  return resolve(baseCwd, input);
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}

const DOC_USAGE = [
  '用法：',
  '- `/doc bind <doc-url|token>`：在群里把云文档绑定到当前群的 backend/session',
  '- `/doc bind <doc-url|token> <backend|default> <session-id>`：显式指定 backend/session',
  '- `/doc status <doc-url|token>` 查看云文档当前配置',
  '- `/doc clear <doc-url|token>` 清除云文档 backend/session 覆盖',
  '',
  '示例：',
  '- `/doc bind https://example.feishu.cn/docx/DOCTOKEN`',
  '- `/doc bind DOCTOKEN claude SESSION_ID`',
].join('\n');

function extractDocToken(input: string): string | undefined {
  const raw = input.trim().replace(/^<|>$/g, '');
  if (!raw) return undefined;

  const tokenFromPath = (path: string): string | undefined => {
    const segments = path.split('/').filter(Boolean);
    const marker = segments.findIndex((segment) => ['doc', 'docx', 'sheet', 'file', 'wiki'].includes(segment));
    return marker >= 0 ? segments[marker + 1] : undefined;
  };

  try {
    const token = tokenFromPath(new URL(raw).pathname);
    if (token) return token;
  } catch {
    // Not a URL; fall through to path/token parsing.
  }

  const pathMatch = raw.match(/(?:^|\/)(?:doc|docx|sheet|file|wiki)\/([A-Za-z0-9_-]+)/);
  if (pathMatch?.[1]) return pathMatch[1];
  return /^[A-Za-z0-9_-]{6,}$/.test(raw) ? raw : undefined;
}

function docScopeForInput(input: string): string | undefined {
  const token = extractDocToken(input);
  return token ? `doc:${token}` : undefined;
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  if (trimmed === 'worktree' || trimmed.startsWith('worktree ')) {
    const name = trimmed === 'worktree' ? '' : trimmed.slice('worktree'.length).trim();
    return handleNewWorktree(name, ctx);
  }

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  await ctx.agent.evictScope?.(ctx.scope, workspaceCwd(ctx));
  ctx.sessions.clear(ctx.scope, ctx.agent.sessionKey);
  const cwd = effectiveCwd(ctx);
  await ensureResumeSession(ctx.agent, ctx.sessions, ctx.scope, cwd);
  await replyCard(
    ctx,
    commandStatusCard({
      title: wasRunning ? '已中断当前任务并开始新会话' : '已开始新会话',
      status: 'success',
      lines: [
        `cwd: \`${cwd}\``,
        '当前 session 已清空并预创建，下一条消息会进入新 agent 会话。',
        wasRunning ? '原运行中的任务会在其卡片上显示为已中断。' : '',
      ].filter(Boolean),
    }),
  );
}

async function handleNewWorktree(name: string, ctx: CommandContext): Promise<void> {
  const validationError = validateWorktreeName(name);
  if (validationError) {
    await reply(ctx, `❌ ${validationError}\n用法：\`/new worktree <name>\``);
    return;
  }

  const cwd = effectiveCwd(ctx);
  const prefix = getWorktreeBranchPrefix(ctx.controls.cfg);
  let createdWorktree;
  try {
    createdWorktree = await createGitWorktree(cwd, prefix, name);
  } catch (err) {
    await reply(ctx, `❌ 创建 worktree 失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let createdChat;
  try {
    createdChat = await createBoundChat({
      channel: ctx.channel,
      name: nameWithBackend(name, ctx.backendKey),
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    await reply(
      ctx,
      `⚠️ worktree 已创建，但创建群聊失败：${err instanceof Error ? err.message : String(err)}\n` +
        `branch：\`${createdWorktree.branch}\`\npath：\`${createdWorktree.path}\``,
    );
    return;
  }

  ctx.workspaces.setCwd(createdChat.chatId, createdWorktree.path);
  ctx.backendStore?.set(createdChat.chatId, ctx.backendKey);
  await reply(
    ctx,
    `✓ 已创建 worktree 群聊：${createdChat.name}\n` +
      `branch：\`${createdWorktree.branch}\`\n` +
      `base：\`${createdWorktree.base}\`\n` +
      `cwd：\`${createdWorktree.path}\``,
  );
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = workspaceCwd(ctx);
  const name = rawName || backendChatName(ctx.backendKey);

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace; otherwise it'll fall back to $HOME.
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }

  // Welcome the user inside the new group with a hint about how to start.
  const welcome = sourceCwd
    ? `🎉 群已建好，cwd 继承自原群：\`${sourceCwd}\`\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(
    ctx,
    `✓ 已创建群 **${created.name}**，去新群里继续。`,
  );
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <路径>`，支持绝对路径、`~/xxx` 或相对当前 cwd 的路径。');
    return;
  }
  const absolute = resolveCdInput(input, effectiveCwd(ctx));
  try {
    const st = await stat(absolute);
    if (!st.isDirectory()) {
      await reply(ctx, `路径不是目录：\`${absolute}\``);
      return;
    }
  } catch {
    await reply(ctx, `路径不存在：\`${absolute}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  await ctx.agent.evictScope?.(ctx.scope, workspaceCwd(ctx));
  ctx.workspaces.setCwd(workspaceScope(ctx), absolute);
  ctx.sessions.clear(ctx.scope, ctx.agent.sessionKey);
  await ensureResumeSession(ctx.agent, ctx.sessions, ctx.scope, absolute);
  await reply(ctx, `✓ 已切换 cwd 到 \`${absolute}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = ctx.workspaces.listNamed();
  const currentCwd = workspaceCwd(ctx);
  const card = workspacesCard(currentCwd, named);
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = workspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前 chat 未设置 cwd，先用 `/cd` 设置再保存。');
    return;
  }
  ctx.workspaces.saveNamed(name, cwd);
  await reply(ctx, `✓ 工作空间已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = ctx.workspaces.getNamed(name);
  if (!cwd) {
    await reply(ctx, `未找到工作空间：\`${name}\``);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  await ctx.agent.evictScope?.(ctx.scope, workspaceCwd(ctx));
  ctx.workspaces.setCwd(workspaceScope(ctx), cwd);
  ctx.sessions.clear(ctx.scope, ctx.agent.sessionKey);
  await ensureResumeSession(ctx.agent, ctx.sessions, ctx.scope, cwd);
  await reply(ctx, `✓ 已切换到 \`${name}\` (${cwd})\n（session 已重置）`);
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!ctx.workspaces.removeNamed(name)) {
    await reply(ctx, `未找到工作空间：\`${name}\``);
    return;
  }
  await reply(ctx, `✓ 已删除工作空间：\`${name}\``);
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return applyResume(rest, ctx);
  }

  // Default: list recent sessions
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;

  const cwd = effectiveCwd(ctx);
  if (ctx.agent.id !== 'claude') {
    await reply(ctx, '当前 agent 暂不支持历史会话列表；已有 bridge session 会自动续上，可用 `/new` 开新会话。');
    return;
  }
  const sessions = await listRecentSessions(cwd, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope, ctx.agent.sessionKey);
  const entries = sessions.map((s) => ({
    sessionId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId,
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveCwd(ctx);
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, ctx.agent.sessionKey, sessionId, cwd);
  await reply(
    ctx,
    `✓ 已恢复会话 \`${sessionId.slice(0, 8)}…\`。接着发消息就行。`,
  );
}

async function handleRuns(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.runHistory) {
    await reply(ctx, '当前运行环境不支持运行记录。');
    return;
  }
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/);
  const runId = parts[0] === 'detail' ? parts.slice(1).join(' ') : trimmed;
  if (runId) {
    const entry = ctx.runHistory.get(runId);
    if (!entry) {
      await reply(ctx, `找不到运行记录：\`${runId}\`（只保留最近若干小时的任务）。`);
      return;
    }
    if (entry.scope !== ctx.scope) {
      await reply(ctx, '这个任务属于另一个会话/话题，不能在当前会话查看。');
      return;
    }
    await replyCard(ctx, runDetailCard(entry));
    return;
  }

  const cwd = effectiveCwd(ctx);
  await replyCard(ctx, runsCard({ cwd, entries: ctx.runHistory.list(ctx.scope, 10) }));
}

async function handleBackend(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.agentRegistry || !ctx.backendStore) {
    await reply(ctx, '当前运行环境不支持多 backend。');
    return;
  }
  const requested = args.trim();
  if (!requested) {
    await reply(ctx, [
      `当前 backend：\`${ctx.backendKey}\` (${ctx.agent.displayName})`,
      `默认 backend：\`${ctx.agentRegistry.defaultKey()}\``,
      `可用 backend：${ctx.agentRegistry.keys().map((key) => `\`${key}\``).join(', ')}`,
      '用法：`/backend <key>` 或 `/backend default`',
    ].join('\n'));
    return;
  }
  const nextKey = requested === 'default' ? ctx.agentRegistry.defaultKey() : requested;
  if (!ctx.agentRegistry.has(nextKey)) {
    await reply(ctx, `未知 backend：\`${requested}\`\n可用 backend：${ctx.agentRegistry.keys().map((key) => `\`${key}\``).join(', ')}`);
    return;
  }

  const nextAgent = await ctx.agentRegistry.get(nextKey);
  ctx.activeRuns.interrupt(ctx.scope);
  await ctx.agent.evictScope?.(ctx.scope, workspaceCwd(ctx));
  if (requested === 'default') ctx.backendStore.clear(ctx.scope);
  else ctx.backendStore.set(ctx.scope, nextKey);

  let renameStatus = '';
  if (ctx.chatMode === 'group') {
    try {
      await renameChatForBackend(ctx.channel, ctx.msg.chatId, 'Chat', nextKey);
      renameStatus = `\n群名已更新为 ${backendLabel(nextKey)} 后缀。`;
    } catch {
      renameStatus = '\nbackend 已切换；群名更新失败，请确认 bot 具备 chat 更新权限。';
    }
  }
  await reply(ctx, `已切换 backend 到 \`${nextKey}\`（${nextAgent.displayName}）。\n已有 session 会继续保留；如需新会话请使用 /reset。${renameStatus}`);
}

async function handleDoc(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';

  switch (sub) {
    case 'bind':
      return handleDocBind(parts.slice(1), ctx);
    case 'status':
      return handleDocStatus(parts.slice(1), ctx);
    case 'clear':
      return handleDocClear(parts.slice(1), ctx);
    default:
      await reply(ctx, DOC_USAGE);
  }
}

async function handleDocBind(parts: string[], ctx: CommandContext): Promise<void> {
  if (parts.length === 1) {
    return handleDocBindCurrentChat(parts[0] ?? '', ctx);
  }
  if (parts.length < 3) {
    await reply(ctx, DOC_USAGE);
    return;
  }
  return handleDocBindExplicit(parts, ctx);
}

async function handleDocBindCurrentChat(docInput: string, ctx: CommandContext): Promise<void> {
  if (ctx.chatMode === 'p2p') {
    await reply(ctx, '快捷绑定只能在群聊或话题群里使用；私聊请使用 `/doc bind <doc-url|token> <backend|default> <session-id>`。');
    return;
  }
  if (!ctx.agentRegistry || !ctx.backendStore) {
    await reply(ctx, '当前运行环境不支持多 backend，无法为云文档指定 backend。');
    return;
  }

  const scope = docScopeForInput(docInput);
  if (!scope) {
    await reply(ctx, `无法识别云文档 token：\`${docInput}\``);
    return;
  }

  const currentBackend = ctx.backendStore.get(ctx.scope);
  const backendKey = currentBackend && ctx.agentRegistry.has(currentBackend)
    ? currentBackend
    : ctx.agentRegistry.defaultKey();
  const nextAgent = await ctx.agentRegistry.get(backendKey);
  const currentSession = ctx.sessions.getRaw(ctx.scope, nextAgent.sessionKey);
  if (!currentSession?.sessionId) {
    await reply(ctx, '当前群还没有可绑定的 session，请先在群里完成一次 agent 对话后再绑定。');
    return;
  }

  const previousKey = ctx.backendStore.get(scope);
  const previousAgent = await ctx.agentRegistry.getOrDefault(previousKey);
  const cwd = currentSession.cwd ?? effectiveCwd(ctx);

  ctx.activeRuns.interrupt(scope);
  await previousAgent.evictScope?.(scope, cwd);
  if (currentBackend) ctx.backendStore.set(scope, backendKey);
  else ctx.backendStore.clear(scope);
  ctx.sessions.set(scope, nextAgent.sessionKey, currentSession.sessionId, cwd);

  await replyCard(
    ctx,
    commandStatusCard({
      title: '已绑定云文档到当前群会话',
      status: 'success',
      lines: [
        `scope: \`${scope}\``,
        `backend: \`${backendKey}\`（${nextAgent.displayName}）`,
        `session: \`${shortId(currentSession.sessionId)}\``,
        `cwd: \`${cwd}\``,
        '后续在该文档里 @bot 时会使用当前群的 backend/session。',
      ],
    }),
  );
}

async function handleDocBindExplicit(parts: string[], ctx: CommandContext): Promise<void> {
  if (!ctx.agentRegistry || !ctx.backendStore) {
    await reply(ctx, '当前运行环境不支持多 backend，无法为云文档指定 backend。');
    return;
  }

  const [docInput, backendInput, sessionId] = parts;
  const scope = docScopeForInput(docInput ?? '');
  if (!scope) {
    await reply(ctx, `无法识别云文档 token：\`${docInput ?? ''}\``);
    return;
  }
  if (!backendInput || !sessionId) {
    await reply(ctx, DOC_USAGE);
    return;
  }

  const backendKey = backendInput === 'default' ? ctx.agentRegistry.defaultKey() : backendInput;
  if (!ctx.agentRegistry.has(backendKey)) {
    await reply(ctx, `未知 backend：\`${backendInput}\`\n可用 backend：${ctx.agentRegistry.keys().map((key) => `\`${key}\``).join(', ')}`);
    return;
  }

  const previousKey = ctx.backendStore.get(scope);
  const previousAgent = await ctx.agentRegistry.getOrDefault(previousKey);
  const nextAgent = await ctx.agentRegistry.get(backendKey);
  const cwd = ctx.workspaces.cwdFor(scope) ?? homedir();

  ctx.activeRuns.interrupt(scope);
  await previousAgent.evictScope?.(scope, cwd);
  if (backendInput === 'default') ctx.backendStore.clear(scope);
  else ctx.backendStore.set(scope, backendKey);
  ctx.sessions.set(scope, nextAgent.sessionKey, sessionId, cwd);

  await replyCard(
    ctx,
    commandStatusCard({
      title: '已绑定云文档会话',
      status: 'success',
      lines: [
        `scope: \`${scope}\``,
        `backend: \`${backendKey}\`（${nextAgent.displayName}）`,
        `session: \`${shortId(sessionId)}\``,
        `cwd: \`${cwd}\``,
        '后续在该文档里 @bot 时会优先使用这个 backend/session。',
      ],
    }),
  );
}

async function handleDocStatus(parts: string[], ctx: CommandContext): Promise<void> {
  const [docInput] = parts;
  const scope = docScopeForInput(docInput ?? '');
  if (!scope) {
    await reply(ctx, DOC_USAGE);
    return;
  }

  const requestedBackend = ctx.backendStore?.get(scope);
  const backendKey = ctx.agentRegistry
    ? requestedBackend && ctx.agentRegistry.has(requestedBackend)
      ? requestedBackend
      : ctx.agentRegistry.defaultKey()
    : ctx.backendKey;
  const agent = ctx.agentRegistry ? await ctx.agentRegistry.get(backendKey) : ctx.agent;
  const activeSession = ctx.sessions.getRaw(scope, agent.sessionKey);
  const allSessions = ctx.sessions.getRaw(scope);
  const sessionLines = Object.entries(allSessions?.agents ?? {}).map(
    ([sessionKey, entry]) => `- \`${sessionKey}\`: \`${shortId(entry.sessionId)}\` (${new Date(entry.updatedAt).toLocaleString()})`,
  );

  await replyCard(
    ctx,
    commandStatusCard({
      title: '云文档会话配置',
      status: 'info',
      lines: [
        `scope: \`${scope}\``,
        `backend: \`${backendKey}\`${requestedBackend ? '（文档覆盖）' : '（跟随默认）'}`,
        `当前 backend session: ${activeSession?.sessionId ? `\`${shortId(activeSession.sessionId)}\`` : '(无)'}`,
        sessionLines.length > 0 ? `已保存 sessions:\n${sessionLines.join('\n')}` : '已保存 sessions: (无)',
      ],
    }),
  );
}

async function handleDocClear(parts: string[], ctx: CommandContext): Promise<void> {
  const [docInput] = parts;
  const scope = docScopeForInput(docInput ?? '');
  if (!scope) {
    await reply(ctx, DOC_USAGE);
    return;
  }

  const cwd = ctx.workspaces.cwdFor(scope) ?? homedir();
  const previousKey = ctx.backendStore?.get(scope);
  const previousAgent = ctx.agentRegistry ? await ctx.agentRegistry.getOrDefault(previousKey) : ctx.agent;
  ctx.activeRuns.interrupt(scope);
  await previousAgent.evictScope?.(scope, cwd);
  const clearedBackend = ctx.backendStore?.clear(scope) ?? false;
  const hadSessions = Boolean(ctx.sessions.getRaw(scope));
  ctx.sessions.clear(scope);

  await replyCard(
    ctx,
    commandStatusCard({
      title: '已清除云文档会话配置',
      status: clearedBackend || hadSessions ? 'success' : 'info',
      lines: [
        `scope: \`${scope}\``,
        clearedBackend ? '已清除文档 backend 覆盖。' : '没有文档 backend 覆盖。',
        hadSessions ? '已清除该文档下保存的 sessions。' : '没有该文档下保存的 session。',
      ],
    }),
  );
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveCwd(ctx);
  const sess = ctx.sessions.getRaw(ctx.scope, ctx.agent.sessionKey);
  const latestRun = ctx.runHistory?.list(ctx.scope, 1)[0];
  const card = statusCard({
    cwd,
    sessionId: sess?.sessionId,
    sessionStale: Boolean(sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    scope: ctx.scope,
    chatMode: ctx.chatMode,
    agent: ctx.agent.descriptor,
    latestRun,
  });
  await replyCard(ctx, card);
}

async function handleStop(_args: string, ctx: CommandContext): Promise<void> {
  let droppedPersistent = 0;
  try {
    droppedPersistent = await ctx.persistentQueue?.cancelScope(ctx.scope) ?? 0;
  } catch (err) {
    log.fail('command', err, { step: 'stop-persistent-cancel', scope: ctx.scope });
    await replyCard(
      ctx,
      commandStatusCard({
        title: '终止任务失败',
        status: 'error',
        lines: ['持久化队列清理失败，已保留运行中任务和内存队列以避免状态不一致。请检查日志后重试 `/stop`。'],
      }),
    );
    return;
  }

  const ok = ctx.activeRuns.interrupt(ctx.scope);
  const droppedPending = ctx.pending?.cancel(ctx.scope).length ?? 0;
  log.info('command', 'stop', { interrupted: ok, droppedPending, droppedPersistent });
  await replyCard(
    ctx,
    commandStatusCard({
      title: ok || droppedPending > 0 || droppedPersistent > 0 ? '已请求终止当前任务' : '当前没有运行中的任务',
      status: ok || droppedPending > 0 || droppedPersistent > 0 ? 'warning' : 'info',
      lines: ok || droppedPending > 0 || droppedPersistent > 0
        ? ['运行卡片会更新为“已被中断”。如果卡片没有及时变化，可用 `/status` 或 `/workers` 复查。']
        : ['没有找到当前会话正在执行的 agent run。'],
    }),
  );
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!trimmed) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(ctx.scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 chat/topic 设 15 分钟\n- `/timeout off` 当前 chat/topic 关闭探活\n- `/timeout default` 清除覆盖,回退全局';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await replyCard(
        ctx,
        commandStatusCard({
          title: '当前 session 探活设置',
          status: 'info',
          lines: [`当前 session: ${effective}`, `全局默认: ${formatGlobal()}`, usage],
        }),
      );
      return;
    }
    await replyCard(
      ctx,
      commandStatusCard({
        title: '当前 session 探活设置',
        status: 'info',
        lines: [`当前 session: 跟随全局`, `全局默认: ${formatGlobal()}`, usage],
      }),
    );
    return;
  }

  if (trimmed === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(ctx.scope);
    log.info('command', 'timeout-clear', { scope: ctx.scope, cleared });
    await replyCard(
      ctx,
      commandStatusCard({
        title: cleared ? '已清除 session 探活覆盖' : 'session 未设置探活覆盖',
        status: 'success',
        lines: [`当前 session: 跟随全局`, `全局默认: ${formatGlobal()}`],
      }),
    );
    return;
  }

  if (trimmed === 'off' || trimmed === '0') {
    ctx.sessions.setIdleTimeoutMinutes(ctx.scope, 0);
    log.info('command', 'timeout-off', { scope: ctx.scope });
    await replyCard(
      ctx,
      commandStatusCard({
        title: '已关闭当前 session 探活',
        status: 'warning',
        lines: ['当前 session 不会因为 agent 长时间无事件而自动终止。', `全局默认仍为: ${formatGlobal()}`],
      }),
    );
    return;
  }

  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(ctx.scope, n);
  log.info('command', 'timeout-set', { scope: ctx.scope, minutes: n });
  await replyCard(
    ctx,
    commandStatusCard({
      title: '已更新当前 session 探活',
      status: 'success',
      lines: [`当前 session: ${n} 分钟`, `全局默认: ${formatGlobal()}`, '`/timeout default` 可恢复跟随全局。'],
    }),
  );
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleWorkers(_args: string, ctx: CommandContext): Promise<void> {
  const snapshots = ctx.agent.workerSnapshots?.() ?? [];
  if (snapshots.length === 0) {
    await reply(ctx, '当前 agent 没有可诊断的 SDK worker pool，或 pool 为空。');
    return;
  }
  const lines = snapshots.map((worker, idx) => {
    const last = worker.lastEventAt ? `${formatRelTime(worker.lastEventAt)}` : '-';
    const age = worker.startedAt ? `${formatRelTime(worker.startedAt)}` : '-';
    return [
      `**${idx + 1}. ${worker.status}** pid=${worker.pid ?? '-'}`,
      `key=\`${worker.key}\``,
      `pending=${worker.pendingRuns}`,
      worker.currentRunId ? `run=\`${shortId(worker.currentRunId)}\`` : '',
      `started=${age}`,
      `lastEvent=${last}`,
      worker.agentId ? `agent=\`${shortId(worker.agentId)}\`` : '',
      worker.cwd ? `cwd=\`${worker.cwd}\`` : '',
      worker.lastError ? `lastError=${worker.lastError}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  });
  await reply(ctx, ['🧪 **SDK workers**', '', ...lines].join('\n'));
}

async function handleRetry(args: string, ctx: CommandContext): Promise<void> {
  const runId = args.trim();
  if (!runId) {
    await reply(ctx, '用法：`/retry <run-id>`，或点击失败卡片上的重试按钮。');
    return;
  }
  if (!ctx.pending || !ctx.persistentQueue || !ctx.runHistory) {
    await reply(ctx, '当前运行环境不支持重试队列。');
    return;
  }
  const entry = ctx.runHistory.get(runId);
  if (!entry) {
    await reply(ctx, `找不到可重试的任务：\`${runId}\`（只保留最近若干小时的失败任务）。`);
    return;
  }
  if (entry.scope !== ctx.scope) {
    await reply(ctx, '这个任务属于另一个会话/话题，不能在当前会话重试。');
    return;
  }
  if (entry.terminal !== 'error' && entry.terminal !== 'idle_timeout') {
    await reply(ctx, '这个任务状态不能重试；只有失败或超时的任务可以重试。');
    return;
  }
  const currentCwd = effectiveCwd(ctx);
  if (entry.cwd !== currentCwd) {
    await reply(ctx, '这个任务属于另一个工作目录，不能在当前 cwd 重试。');
    return;
  }
  if (entry.agent.sessionKey !== ctx.agent.sessionKey) {
    await reply(ctx, '这个任务属于另一个 agent 后端，不能用当前 agent 重试。');
    return;
  }
  const retryBatch = entry.batch.map((msg) => ({ ...msg }));
  const record = await ctx.persistentQueue.enqueue(ctx.scope, retryBatch);
  ctx.activeRuns.interrupt(ctx.scope);
  const size = ctx.pending.pushBatch(ctx.scope, retryBatch, { durableId: record.id });
  await reply(ctx, `已重新排队上次任务（${entry.batch.length} 条消息，当前队列 ${size}）。`);
}

const SHELL_TIMEOUT_MS = 10 * 60_000;
const SHELL_OUTPUT_MAX_CHARS = 12_000;

interface ShellRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

async function handleShell(args: string, ctx: CommandContext): Promise<void> {
  const command = args.trim();
  if (!command) {
    await reply(ctx, '用法：`/shell <command>`\n在当前 cwd 执行 shell 命令，并回传 stdout/stderr。');
    return;
  }

  const cwd = effectiveCwd(ctx);
  log.info('command', 'shell-start', {
    cwd,
    commandChars: command.length,
    timeoutMs: SHELL_TIMEOUT_MS,
  });

  const result = await runShellCommand(command, cwd, SHELL_TIMEOUT_MS, SHELL_OUTPUT_MAX_CHARS);
  log.info('command', 'shell-done', {
    cwd,
    durationMs: result.durationMs,
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
  });

  await reply(ctx, formatShellResult(command, cwd, result));
  await sendCompletionCheckMessage(
    ctx.channel,
    ctx.msg.chatId,
    ctx.msg.threadId ? replyOptions(ctx) : undefined,
  );
}

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<ShellRunResult> {
  return new Promise((resolveShell) => {
    const startedAt = Date.now();
    let timedOut = false;
    let truncated = false;
    let remaining = maxOutputChars;
    let stdout = '';
    let stderr = '';

    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const text = String(chunk);
      const slice = text.slice(0, remaining);
      remaining -= slice.length;
      if (slice.length < text.length) truncated = true;
      if (target === 'stdout') stdout += slice;
      else stderr += slice;
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd,
        env: process.env,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolveShell({
        code: null,
        signal: null,
        stdout,
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated,
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));

    let forceKillTimer: NodeJS.Timeout | undefined;
    const killTimer = setTimeout(() => {
      timedOut = true;
      forceKillTimer = terminateShellProcess(child.pid);
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      stderr += `${stderr ? '\n' : ''}${err instanceof Error ? err.message : String(err)}`;
      resolveShell({
        code: null,
        signal: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveShell({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated,
      });
    });
  });
}

function terminateShellProcess(pid: number | undefined): NodeJS.Timeout | undefined {
  if (!pid) return undefined;
  try {
    if (process.platform === 'win32') {
      process.kill(pid, 'SIGTERM');
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    /* process already exited */
  }
  const forceKillTimer = setTimeout(() => {
    try {
      if (process.platform === 'win32') {
        process.kill(pid, 'SIGKILL');
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      /* process already exited */
    }
  }, 2000).unref();
  return forceKillTimer;
}

function formatShellResult(command: string, cwd: string, result: ShellRunResult): string {
  const status = result.timedOut
    ? `timed out after ${Math.round(SHELL_TIMEOUT_MS / 1000)}s`
    : result.signal
      ? `signal ${result.signal}`
      : `exit ${result.code ?? 'unknown'}`;
  const notes = [
    result.truncated ? `输出已截断到 ${SHELL_OUTPUT_MAX_CHARS} 字符。` : '',
    `duration: ${formatDuration(result.durationMs)}`,
  ].filter(Boolean);
  return [
    `**/shell ${status}**`,
    '',
    `cwd: \`${escapeInlineCode(cwd)}\``,
    `command: \`${escapeInlineCode(command)}\``,
    notes.length > 0 ? notes.join('\n') : '',
    '',
    '**stdout**',
    fencedOutput(result.stdout),
    '',
    '**stderr**',
    fencedOutput(result.stderr),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function fencedOutput(text: string): string {
  const body = text.trimEnd() || '(empty)';
  return ['```text', escapeFence(body), '```'].join('\n');
}

function escapeFence(text: string): string {
  return text.replace(/```/g, '``\u200b`');
}

function escapeInlineCode(text: string): string {
  return text.replace(/`/g, '\u02cb');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function parseClearForce(args: string): boolean | undefined {
  const trimmed = args.trim();
  if (!trimmed) return false;
  if (trimmed === '--force' || trimmed === '-f') return true;
  return undefined;
}

function formatClearSafetyIssues(target: WorktreeClearTarget): string {
  return target.safetyIssues.map((issue) => `- ${issue}`).join('\n');
}

function formatWorktreeClearError(err: unknown): string {
  if (err instanceof WorktreeClearError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function formatClearSuccess(target: WorktreeClearTarget, force: boolean, interrupted: boolean, historyPaths: string[]): string {
  const lines = [
    '✓ 本地清理已完成。',
    '',
    `worktree：\`${target.path}\``,
    `branch：\`${target.branch}\``,
    force ? '模式：force（已允许丢弃未提交/未合并内容）' : '模式：安全清理',
    interrupted ? '已请求终止当前运行中的任务。' : '',
    historyPaths.length > 0 ? `已清理本地历史：${historyPaths.map((p) => `\`${p}\``).join(', ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function formatCleanupFailure(step: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `❌ 清理失败（${step}）：${message}\n当前群聊保留，方便你处理后重试。`;
}

async function handleClear(args: string, ctx: CommandContext): Promise<void> {
  const force = parseClearForce(args);
  if (force === undefined) {
    await reply(ctx, '用法：`/clear [--force|-f]`');
    return;
  }
  if (ctx.chatMode !== 'group') {
    await reply(ctx, '❌ `/clear` 只能在 worktree 专属群聊中使用，不能在私聊或话题里使用。');
    return;
  }

  const cwd = workspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '❌ 当前群没有绑定 cwd，无法判断要清理哪个 worktree。');
    return;
  }

  let target: WorktreeClearTarget;
  try {
    target = await inspectWorktreeClearTarget(cwd);
  } catch (err) {
    await reply(ctx, `❌ 当前 cwd 不是可清理的 worktree：${formatWorktreeClearError(err)}`);
    return;
  }

  if (!force && target.safetyIssues.length > 0) {
    await reply(
      ctx,
      [
        '❌ 当前 worktree 仍有未保存或未合并内容，已停止清理。',
        '',
        formatClearSafetyIssues(target),
        '',
        '确认要丢弃这些内容时再执行：`/clear --force` 或 `/clear -f`',
      ].join('\n'),
    );
    return;
  }

  const logMeta = {
    scope: ctx.scope,
    chatId: ctx.msg.chatId,
    cwd,
    branch: target.branch,
    force,
  };

  let interrupted = false;
  let historyPaths: string[] = [];
  try {
    log.info('command', 'clear-start', logMeta);
    interrupted = ctx.activeRuns.interrupt(ctx.scope);
    await ctx.agent.evictScope?.(ctx.scope, cwd);
    ctx.sessions.clear(ctx.scope);
    ctx.workspaces.clearCwd(workspaceScope(ctx));
    ctx.backendStore?.clear(ctx.scope);
    historyPaths = await removeLocalAgentHistory(cwd);
    await removeGitWorktreeAndBranch(target, force);
  } catch (err) {
    log.fail('command', err, { ...logMeta, step: 'cleanup' });
    await reply(ctx, formatCleanupFailure('本地清理', err));
    return;
  }

  await reply(ctx, formatClearSuccess(target, force, interrupted, historyPaths));

}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

async function handleReconnect(_args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'reconnect');
  await reply(ctx, '⏳ 正在重连…');
  try {
    await ctx.controls.restart();
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

const DOCTOR_INSTRUCTIONS = `你是 lark-agent-bridge 的诊断助理。下面会给你两段输入:
1. 用户的故障描述
2. 最近的 run timeline 和运行日志(JSON line 格式,旧→新)

日志字段含义:
- ts: ISO 时间戳
- level: info | warn | error
- phase: 模块阶段。常见值: ws(WebSocket), intake(消息入站), queue(去抖队列), flush(批处理), media(附件下载), prompt(prompt 组装), session(会话), agent(claude 子进程), card(卡片渲染), comment(文档评论), cardAction(卡片回调), command(斜杠命令), sdk(飞书 SDK 内部)
- event: enter | exit | transition | fail | 各 phase 自定义事件
- traceId: 同一逻辑操作的串联 ID(同一条消息的多个日志会共享)
- chatId: 飞书聊天 ID(用 chatId 反查相关日志)
- run timeline: 已按 runId 提炼的关键阶段，用来快速定位卡在 intake / queue / session / agent / card update / done 哪一步

回复严格三段,markdown 标题用二级:

## 可能原因
1-3 条最有可能的原因,每条带具体日志的时间戳或 traceId 引用。

## 关键日志片段
3-5 条最重要的日志,直接贴 JSON 行原文,后跟一行说明为什么重要。

## 建议下一步
1-3 条具体可执行的动作(检查 X / 重启 Y / 等待 Z 之类)。

如果日志里没有任何相关线索,直接说"日志不足以判断,建议:"再列动作。回复要直接,不寒暄。`;

function buildDoctorPrompt(description: string, logs: string, timeline: string): string {
  const desc = description.trim() || '(用户没写描述,自行从日志找最显眼的异常。)';
  return `${DOCTOR_INSTRUCTIONS}

---

用户故障描述:
${desc}

Run timeline:
\`\`\`
${timeline || '(最近日志里没有 run timeline 事件。)'}
\`\`\`

最近的运行日志:
\`\`\`
${logs}
\`\`\``;
}

function buildRunTimeline(logs: string): string {
  const entries = logs
    .split('\n')
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try {
        return [JSON.parse(trimmed) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .filter((entry) => isTimelineEntry(entry) || isCardOrStreamFailure(entry));

  if (entries.length === 0) return '';

  return entries
    .slice(-80)
    .map((entry) => {
      const ts = typeof entry.ts === 'string' ? entry.ts : '-';
      const trace = typeof entry.traceId === 'string' ? ` trace=${entry.traceId}` : '';
      const runId = typeof entry.runId === 'string' ? ` run=${shortId(entry.runId)}` : '';
      const phase = typeof entry.phase === 'string' ? entry.phase : '-';
      const event = typeof entry.event === 'string' ? entry.event : '-';
      const step = typeof entry.step === 'string' ? ` step=${entry.step}` : '';
      const mode = typeof entry.mode === 'string' ? ` mode=${entry.mode}` : '';
      const terminal = typeof entry.terminal === 'string' ? ` terminal=${entry.terminal}` : '';
      const err = typeof entry.err === 'string' ? ` err=${entry.err.slice(0, 180)}` : '';
      const reason = typeof entry.reason === 'string' ? ` reason=${entry.reason.slice(0, 180)}` : '';
      return `${ts}${trace}${runId} ${phase}.${event}${step}${mode}${terminal}${err}${reason}`;
    })
    .join('\n');
}

function isTimelineEntry(entry: Record<string, unknown>): boolean {
  return entry.phase === 'run' && entry.event === 'timeline';
}

function isCardOrStreamFailure(entry: Record<string, unknown>): boolean {
  if (entry.phase === 'stream' && entry.event === 'fail') return true;
  if (entry.phase === 'card' && (entry.event === 'fail' || entry.event === 'final' || entry.event === 'transition')) {
    return true;
  }
  return false;
}

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  if (args.trim().toLowerCase() === 'workers') {
    return handleWorkers('', ctx);
  }
  if (args.trim().toLowerCase() === 'setup') {
    const cwd = effectiveCwd(ctx);
    const result = await runSetupDiagnostics({
      cfg: ctx.controls.cfg,
      configPath: ctx.controls.configPath,
      agent: ctx.agent,
      cwd,
      chat: { chatId: ctx.msg.chatId, chatMode: ctx.chatMode, senderId: ctx.msg.senderId },
      sameAppProcesses: sameAppOthers(ctx.controls.cfg.accounts.app.id),
    });
    await replyCard(ctx, setupDiagnosticsCard(result));
    return;
  }
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });
  // Killing any in-flight run on this chat — /doctor is a "I'm stuck" call.
  ctx.activeRuns.interrupt(ctx.scope);

  const rawLogs = await readRecentLogs({ maxBytes: 60_000 });
  if (!rawLogs.trim()) {
    await ctx.channel.send(
      ctx.msg.chatId,
      { text: '没有找到日志文件 — bridge 可能刚启动或日志目录不可写。' },
      { replyTo: ctx.msg.messageId },
    );
    return;
  }
  // Scrub identifying / credential material before the logs (a) reach
  // Anthropic via the agent prompt, and (b) end up in any card payload
  // Lark may cache server-side.
  const logs = sanitizeLogsForDoctor(rawLogs);
  const timeline = sanitizeLogsForDoctor(buildRunTimeline(rawLogs));

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  const prompt = buildDoctorPrompt(args, logs, timeline);
  const run = ctx.agent.run({
    prompt,
    cwd: homedir(),
    stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
  });
  const handle = ctx.activeRuns.register(ctx.scope, run);

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(initialState),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              const flush = (): Promise<void> => ctrl.update(renderCard(state));
              for await (const evt of handle.run.events) {
                if (handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  if (evt.costUsd !== undefined) {
                    log.info('agent', 'usage', { step: 'doctor', costUsd: Number(evt.costUsd.toFixed(4)) });
                  }
                  continue;
                }
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some claude versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
              await handle.run.stop();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group / topic: buffer to completion, then DM the final card to the
      // operator. No live streaming — the group should see nothing past the
      // ack reply above.
      let state: RunState = initialState;
      for await (const evt of handle.run.events) {
        if (handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          if (evt.costUsd !== undefined) {
            log.info('agent', 'usage', { step: 'doctor', costUsd: Number(evt.costUsd.toFixed(4)) });
          }
          continue;
        }
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      await handle.run.stop();
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: ctx.msg.senderId,
          msg_type: 'interactive',
          content: JSON.stringify(renderCard(state)),
        },
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
  } finally {
    ctx.activeRuns.unregister(ctx.scope, run);
  }
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard();
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

// ─── /account ─────────────────────────────────────────────────────────────

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showCurrent(ctx);
    case 'change':
      return showForm(ctx);
    case 'submit':
      return submitAccount(ctx);
    case 'cancel':
      return cancelAccount(ctx);
    default:
      await reply(ctx, '用法：`/account` 或 `/account change`');
  }
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  // Current-status card has only a [更换凭据] button — never updated in-place,
  // so an inline card is sufficient (and avoids creating a managed card we'd
  // never re-touch).
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  // Cancel = remove the form card. No follow-up message.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

// Lark's client holds a local "form just submitted" state for a short
// window after the click that overrides any cardkit.card.update we issue.
// We always wait at least this long before flipping the form card to its
// terminal (success/failure) state. Empirically ~1s is enough; less than
// that and the update gets reverted to the form's pre-submit state.
const FORM_SETTLE_MS = 1000;

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;
  const restart = ctx.controls.restart;

  // CRITICAL: detach the work from the cardAction handler. Lark's client
  // keeps the form locked while the handler is pending — if we await the
  // 2s settle window inline, the lock holds, and the moment we return the
  // client snaps the card back to its cached form state (overwriting any
  // update we made). Returning immediately lets the lock release; the
  // delayed updateManagedCard then sticks.
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // Success path: in-place update. The card never accepts another submit
    // (success card has no form), so this is fine.
    const finishSuccess = async (card: object): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, card).catch((err) =>
        console.warn('[account] form update failed:', err),
      );
      forgetManagedCard(formMsgId);
    };

    // Failure path: leave the old form card as a static "❌ 校验失败" record
    // (in-place update to a non-form card so it stops responding to clicks),
    // then post a fresh managed form card below for retry. We can't reuse
    // the original card_id for the retry form because Lark's client locks
    // form interactions on it once submitted — even a re-rendered form on
    // the same card_id no longer fires cardActions.
    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
        .catch((err) => console.warn('[account] mark old form failed:', err));
      forgetManagedCard(formMsgId);
      // Don't prefill the secret on retry — pre-filled secrets can get
      // echoed back into the card payload and may persist in Lark's
      // server-side card cache. Keep appId prefilled (non-sensitive).
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId,
      });
      await sendManagedCard(channel, chatId, retry).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure('App ID 或 App Secret 为空');
      return;
    }

    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? 'unknown');
      return;
    }

    // Encrypted-at-rest path: store the plaintext secret in the AES keystore,
    // and write config.json with an exec-provider SecretRef instead of the
    // raw secret. lark-cli's `config bind --source lark-channel` reads the
    // same SecretRef and goes through the exec protocol to retrieve the
    // plaintext into its own OS keychain — no plaintext on disk.
    let newCfg: AppConfig;
    try {
      newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
      );
      await setSecret(secretKeyForApp(appId), appSecret);
      await saveConfig(newCfg, configPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`保存凭据失败：${msg}`);
      return;
    }

    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));

    // Give the user 1.5s to read the success state before we tear down the
    // WS and reconnect with new credentials.
    setTimeout(() => {
      void restart().catch((err) => {
        console.error('[account] restart failed:', err);
        process.exit(1);
      });
    }, 1500);
  })();
}

async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.rawClient.im.v1.message.delete({
      path: { message_id: messageId },
    });
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

// ────────────── /config — preferences form ──────────────

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showConfigForm(ctx);
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法:`/config`');
  }
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.cfg.preferences?.access ?? {};
  const card = configFormCard({
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    allowedUsers: (access.allowedUsers ?? []).join(', '),
    allowedChats: (access.allowedChats ?? []).join(', '),
    admins: (access.admins ?? []).join(', '),
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(ctx.channel, formMsgId, configCancelledCard()).catch((err) =>
        log.warn('command', 'config-cancel-update-failed', { err: String(err) }),
      );
      forgetManagedCard(formMsgId);
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : 'card';
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  // Parse max_concurrent_runs; invalid input falls back to current value.
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  // Parse run_idle_timeout_minutes. 0 disables; otherwise clamp 1-120.
  // Empty string keeps current value.
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  // Parse require_mention_in_group. Empty / unexpected keeps current.
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let requireMentionInGroup: boolean;
  if (rawRequireMention === 'yes') requireMentionInGroup = true;
  else if (rawRequireMention === 'no') requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);

  // Parse access lists. Comma-separated; trim each, drop empties, dedupe.
  // Empty list = unrestricted (back-compat).
  const parseList = (raw: unknown): string[] => {
    return [...new Set(
      String(raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )];
  };
  const allowedUsers = parseList(fv.allowed_users);
  const allowedChats = parseList(fv.allowed_chats);
  const admins = parseList(fv.admins);

  // Self-lockout guard: if the submitter sets a non-empty admins list that
  // doesn't include themselves, they immediately lose the ability to reopen
  // /config. Refuse the submit and tell them what's wrong.
  if (admins.length > 0 && !admins.includes(ctx.msg.senderId)) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'admins',
      sender: ctx.msg.senderId.slice(-6),
      proposedAdmins: admins.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的管理员列表,但其中不包含你自己的 open_id (\`${ctx.msg.senderId}\`)。这会立即把你自己锁出 /config。请把自己的 open_id 加进去再提交。`,
    );
    return;
  }

  // Symmetrical guard for chat allowlist: if the submitter restricts chats
  // but the chat they're currently in isn't on the list, every message
  // (including the next /config) is silently dropped at intake. Common
  // mistake: filling in *another* chat's id and forgetting the current one.
  //
  // Skipped for p2p: `allowedChats` is group-only (see intakeMessage), so
  // submitting from a DM never locks the submitter out regardless of the
  // chat list contents. Using `chatMode` not `msg.chatType` because card
  // submissions arrive with a synthesized msg that always has chatType='p2p'.
  if (
    ctx.chatMode !== 'p2p' &&
    allowedChats.length > 0 &&
    !allowedChats.includes(ctx.msg.chatId)
  ) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'chats',
      currentChat: ctx.msg.chatId.slice(-6),
      proposedChats: allowedChats.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的群白名单,但其中不包含当前会话的 chat_id (\`${ctx.msg.chatId}\`)。提交后这个会话的消息会被 intake 静默丢弃,bot 不再响应。要么把当前 chat_id 加进白名单,要么清空"群白名单"留待空(=所有会话都响应)。`,
    );
    return;
  }

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;

  // Detach: same reason as account submit — Lark's client locks the form
  // while the cardAction handler is running. Wait out FORM_SETTLE_MS *after*
  // returning so the in-place card update sticks.
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // In-place mutation — the cfg object is shared by reference with
    // runAgentBatch's reads, so this takes effect on the next message.
    ctx.controls.cfg.preferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      // Empty arrays serialize fine but read identically to omitted ones
      // (isUserAllowed / isAdmin both treat length===0 as unrestricted).
      access: { allowedUsers, allowedChats, admins },
    };

    try {
      await saveConfig(ctx.controls.cfg, configPath);
    } catch (err) {
      log.fail('command', err, { step: 'config.save' });
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, configCancelledCard()).catch(() => {});
      forgetManagedCard(formMsgId);
      return;
    }

    log.info('command', 'config-saved', {
      messageReply,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      allowedUsersCount: allowedUsers.length,
      allowedChatsCount: allowedChats.length,
      adminsCount: admins.length,
    });
    await waitForSettle();
    await updateManagedCard(
      channel,
      formMsgId,
      configSavedCard({
        messageReply,
        showToolCalls,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        allowedUsers: allowedUsers.join(', '),
        allowedChats: allowedChats.join(', '),
        admins: admins.join(', '),
      }),
    ).catch((err) =>
      log.warn('command', 'config-save-update-failed', { err: String(err) }),
    );
    forgetManagedCard(formMsgId);
  })();
}
