import { homedir } from 'node:os';
import type {
  CommentEvent,
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuiteoapi/node-sdk';
import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentRegistry } from '../agent/registry';
import type { AgentAdapter } from '../agent/types';
import type { BackendStore } from '../backend/store';
import { handleCardAction } from '../card/dispatcher';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  createInitialState,
  markAgentReady,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { isStopCommandText, parseCommandText, tryHandleCommand, type Controls } from '../commands';
import type { AppConfig } from '../config/schema';
import {
  getAgentStopGraceMs,
  getMarkGroupUnreadOnFinalCard,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isChatAllowed,
  isUserAllowed,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, withTrace } from '../core/logger';
import { MediaCache, type LocalAttachment } from '../media/cache';
import type { SessionStore } from '../session/store';
import { ensureResumeSession } from '../session/ensure-resume';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns, type RunHandle } from './active-runs';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { sendCompletionCheckMessage } from './completion-check';
import { CommentQueue } from './comment-queue';
import { handleCommentMention } from './comments';
import { startKeepalive } from './keepalive';
import { configureNetwork } from './network-config';
import { PendingQueue } from './pending-queue';
import { PersistentQueue } from './persistent-queue';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, renderQuotedBlock, type QuotedContext } from './quote';
import { addWorkingReaction, removeReaction } from './reaction';
import { RunHistory } from './run-history';
import { TimeoutError, withTimeout } from '../utils/timeout';

const PENDING_FLUSH_DELAY_MS = 0;
const SETUP_RETRY_DELAY_MS = 1_000;
const MEDIA_RESOLVE_TIMEOUT_MS = 20_000;
const QUOTE_FETCH_TIMEOUT_MS = 10_000;
const SESSION_PRECREATE_TIMEOUT_MS = 20_000;
const STREAM_UPDATE_TIMEOUT_MS = 15_000;
const MARKDOWN_REFRESH_CUTOFF_MS = 10 * 60_000;
const MARKDOWN_REFRESH_AFTER_CUTOFF_MS = 30_000;
const MARKDOWN_REFRESH_CUTOFF_NOTE =
  '_已运行超过 10 分钟，飞书卡片将停止自动刷新；Agent 会继续在后台工作，完成后会更新最终结果。_';
const FINAL_FLUSH_TIMEOUT_MS = 20_000;
const PROGRESS_REFRESH_MS = 15_000;
const MAX_AUTO_RETRY_KEYS = 200;

export type AutoRetryKeys = Set<string>;

export function commentQueueScope(evt: { fileToken: string }): string {
  return `doc:${evt.fileToken}`;
}

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  // Match either `{ code: <feishu-code> }` (the response data SDK logs as
  // its second arg) or an AxiosError where the feishu code lives at
  // `err.response.data.code` (which the SDK logs raw).
  const codeFromObj = (m: unknown): number | undefined => {
    if (!m || typeof m !== 'object') return undefined;
    const top = (m as { code?: unknown }).code;
    if (typeof top === 'number') return top;
    const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof nested === 'number' ? nested : undefined;
  };
  const isSuppressed = (msg: unknown): boolean => {
    if (Array.isArray(msg)) return msg.some(isSuppressed);
    const code = codeFromObj(msg);
    return code !== undefined && SUPPRESSED_API_ERROR_CODES.has(code);
  };
  return {
    error: (...args: unknown[]) => {
      if (args.some(isSuppressed)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent?: AgentAdapter;
  agentRegistry?: AgentRegistry;
  backendStore?: BackendStore;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
  persistentQueue?: PersistentQueue;
  activeRuns?: ActiveRuns;
}

async function resolveAgentForScope(
  scope: string,
  deps: { agent?: AgentAdapter; agentRegistry?: AgentRegistry; backendStore?: BackendStore },
): Promise<{ agent: AgentAdapter; backendKey: string }> {
  if (!deps.agentRegistry) {
    if (!deps.agent) throw new Error('no agent configured');
    return { agent: deps.agent, backendKey: deps.agent.id };
  }
  const requested = deps.backendStore?.get(scope);
  const key = requested && deps.agentRegistry.has(requested) ? requested : deps.agentRegistry.defaultKey();
  return { agent: await deps.agentRegistry.get(key), backendKey: key };
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, agentRegistry, backendStore, sessions, workspaces, controls } = deps;
  const startupAgent = agentRegistry ? await agentRegistry.getDefault() : agent;
  if (!startupAgent) throw new Error('no agent configured');
  const agentDeps = { agent, agentRegistry, backendStore };
  const activeRuns = deps.activeRuns ?? new ActiveRuns();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  const runHistory = new RunHistory();
  const autoRetryKeys: AutoRetryKeys = new Set();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));

  // Apply network-layer overrides (HTTP timeout + proxy from env). Idempotent;
  // safe to call on every startChannel (used by /account change hot-reload too).
  const netOverrides = configureNetwork();

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg);

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain: cfg.accounts.app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'lark-agent-bridge',
    loggerLevel: LoggerLevel.info,
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // pending-queue + run-chain policy below.
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Optional WS-layer proxy agent (only when HTTPS_PROXY / HTTP_PROXY env set).
    ...(netOverrides.agent ? { agent: netOverrides.agent } : {}),
  };

  const channel = createLarkChannel(opts);
  const media = new MediaCache(channel);
  const persistentQueue = deps.persistentQueue ?? new PersistentQueue();
  let resolveRestoreGate!: () => void;
  const restoreGate = new Promise<void>((resolve) => {
    resolveRestoreGate = resolve;
  });

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock immediately flushes anything queued. Net effect: at most one run
  // per chat in flight, no artificial delay before an idle scope starts work.
  const commentQueue = new CommentQueue<CommentEvent>();

  const pending = new PendingQueue(PENDING_FLUSH_DELAY_MS, (scope, batch, durableId) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', { scope, batchSize: batch.length, durableId });
      // Pool slot acquired here, released in finally. Across-the-bridge cap.
      const release = await pool.acquire();
      let startedRun = false;
      try {
        if (durableId) {
          const runningRecord = await persistentQueue.markRunning(durableId);
          if (!runningRecord) {
            log.warn('queue', 'persistent-missing-before-run', { scope, durableId });
            return;
          }
          log.info('queue', 'persistent-running', { scope, durableId });
        }
        const mode = await chatModeCache.resolve(channel, firstMsg.chatId);
        const resolved = await resolveAgentForScope(scope, agentDeps);
        await runAgentBatch({
          channel,
          agent: resolved.agent,
          sessions,
          workspaces,
          activeRuns,
          media,
          batch,
          controls,
          scope,
          mode,
          runHistory,
          pending,
          persistentQueue,
          durableId,
          autoRetryKeys,
          onRunRegistered: () => {
            startedRun = true;
          },
        });
      } catch (err) {
        log.fail('flush', err);
        if (durableId && !startedRun) {
          setTimeout(() => {
            void withTrace({ chatId: firstMsg.chatId }, async () => {
              const exists = await persistentQueue.has(durableId).catch((retryErr) => {
                log.fail('queue', retryErr, { step: 'persistent-setup-retry-check', scope, durableId });
                return false;
              });
              if (!exists) {
                log.warn('queue', 'persistent-setup-retry-skipped', { scope, durableId });
                return;
              }
              pending.pushBatch(scope, batch, { durableId });
              log.warn('queue', 'persistent-requeued-after-setup-failure', {
                scope,
                durableId,
                batchSize: batch.length,
                delayMs: SETUP_RETRY_DELAY_MS,
              });
            });
          }, SETUP_RETRY_DELAY_MS);
        }
      } finally {
        release();
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    });
  });

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
        await restoreGate;
        await intakeMessage({
          channel,
          agent: startupAgent,
          agentRegistry,
          backendStore,
          sessions,
          workspaces,
          activeRuns,
          pending,
          persistentQueue,
          msg,
          controls,
          runHistory,
          chatModeCache,
        });
      }).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await restoreGate;
        await handleCardAction({
          channel,
          evt,
          sessions,
          workspaces,
          activeRuns,
          agent: startupAgent,
          agentRegistry,
          backendStore,
          controls,
          pending,
          persistentQueue,
          runHistory,
          chatModeCache,
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      const scope = commentQueueScope(evt);
      commentQueue.push(scope, evt, async (queuedEvt) => {
        await withTrace({ chatId: scope }, async () => {
          await handleCommentMention({
            channel,
            evt: queuedEvt,
            agent: startupAgent,
            agentRegistry,
            backendStore,
            sessions,
            workspaces,
          }).catch((err) => log.fail('comment', err));
        }).catch((err) => log.fail('comment', err));
      });
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  await channel.connect();
  try {
    await restorePersistentQueue(persistentQueue, pending);
  } catch (err) {
    log.fail('queue', err, { step: 'persistent-restore' });
  } finally {
    resolveRestoreGate();
  }

  const identity = channel.botIdentity;
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${startupAgent.displayName} (${startupAgent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  return {
    channel,
    disconnect: async () => {
      keepalive.stop();
      commentQueue.cancelAll();
      pending.cancelAll();
      await channel.disconnect();
      await activeRuns.stopAll();
      await Promise.allSettled([sessions.flush(), workspaces.flush()]);
    },
  };
}

export async function restorePersistentQueue(persistentQueue: PersistentQueue, pending: PendingQueue): Promise<number> {
  const records = await persistentQueue.recoverable();
  let restored = 0;
  for (const record of records) {
    if (record.messages.length === 0) continue;
    const size = pending.pushBatch(record.scope, record.messages, { durableId: record.id });
    restored++;
    log.info('queue', 'persistent-restored', {
      scope: record.scope,
      durableId: record.id,
      state: record.state,
      batchSize: record.messages.length,
      queueSize: size,
    });
  }
  return restored;
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  agentRegistry?: AgentRegistry;
  backendStore?: BackendStore;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  persistentQueue: PersistentQueue;
  runHistory: RunHistory;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
}

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    agentRegistry,
    backendStore,
    sessions,
    workspaces,
    activeRuns,
    pending,
    persistentQueue,
    runHistory,
    msg,
    controls,
    chatModeCache,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const chatMode = await chatModeCache.resolve(channel, msg.chatId);
  const scope = msg.threadId
    ? `${msg.chatId}:${msg.threadId}`
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  // Access control. Silent drop — replying would reveal the bot to
  // unauthorized users and let them spam the chat with denial messages.
  // Operator-defined lists; both empty = allow all (back-compat).
  if (!isUserAllowed(controls.cfg, msg.senderId)) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
    });
    return;
  }
  // `allowedChats` is intentionally a group-only gate. p2p chat_ids are
  // generated per-user-pair and can't be hijacked by an unauthorized
  // sender, so the user allowlist above is already authoritative for DMs.
  // Restricting p2p by chat_id would also create a chicken-and-egg lockout
  // hazard (the operator must know the chat_id before they ever DM the bot).
  if (msg.chatType !== 'p2p' && !isChatAllowed(controls.cfg, msg.chatId)) {
    log.info('intake', 'skip-not-allowed-chat', {
      scope,
      chatId: msg.chatId.slice(-6),
    });
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. Slash commands are NOT exempt — the user
  // chose strict mode so the group stays uniformly quiet unless mentioned.
  // @全员 is already filtered by SDK (`respondToMentionAll: false`), so any
  // event reaching here is either targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    getRequireMentionInGroup(controls.cfg) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  const resolved = await resolveAgentForScope(scope, { agent, agentRegistry, backendStore });

  if (isStopCommandText(msg.content)) {
    try {
      const result = await interruptScopeNow(activeRuns, pending, persistentQueue, scope);
      log.info('intake', 'immediate-stop', {
        scope,
        interrupted: result.interrupted,
        droppedPending: result.droppedPending,
        droppedPersistent: result.droppedPersistent,
      });
    } catch (err) {
      log.fail('intake', err, { step: 'immediate-stop', scope });
      await channel.send(msg.chatId, { markdown: '❌ 终止任务失败：持久化队列清理失败，已保留运行中任务和内存队列以避免状态不一致。请检查日志后重试 `/stop`。' }, {
        replyTo: msg.messageId,
        ...(msg.threadId ? { replyInThread: true as const } : {}),
      }).catch((sendErr) => log.fail('intake', sendErr, { step: 'immediate-stop-reply', scope }));
    }
    return;
  }

  const parsedCommand = parseCommandText(msg.content);
  const handled = await tryHandleCommand({
    channel,
    msg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent: resolved.agent,
    agentRegistry,
    backendStore,
    backendKey: resolved.backendKey,
    activeRuns,
    pending,
    persistentQueue,
    runHistory,
    controls,
    cancelQueuedWork: async (targetScope = scope) => {
      const droppedPersistent = await persistentQueue.cancelScope(targetScope);
      const dropped = pending.cancel(targetScope);
      log.info('intake', 'command-drop-pending', {
        scope: targetScope,
        cmd: parsedCommand?.cmd,
        droppedPending: dropped.length,
        droppedPersistent,
      });
    },
  });
  if (handled) {
    log.info('intake', 'command', { scope });
    return;
  }

  let record;
  try {
    record = await persistentQueue.enqueue(scope, [msg]);
  } catch (err) {
    log.fail('intake', err, { step: 'persistent-enqueue', scope, messageId: msg.messageId });
    try {
      await channel.send(msg.chatId, { markdown: '❌ 队列持久化失败，消息未入队。请稍后重试。' }, {
        replyTo: msg.messageId,
        ...(msg.threadId ? { replyInThread: true as const } : {}),
      });
    } catch (sendErr) {
      log.fail('intake', sendErr, { step: 'persistent-enqueue-reply', scope, messageId: msg.messageId });
    }
    return;
  }
  const size = pending.push(scope, msg, { durableId: record.id });
  log.info('intake', 'queued', { scope, queueSize: size, flushDelayMs: PENDING_FLUSH_DELAY_MS, durableId: record.id });
}

export async function interruptScopeNow(
  activeRuns: ActiveRuns,
  pending: PendingQueue,
  persistentQueue: PersistentQueue,
  scope: string,
): Promise<{ interrupted: boolean; droppedPending: number; droppedPersistent: number }> {
  const droppedPersistent = await persistentQueue.cancelScope(scope);
  const interrupted = activeRuns.interrupt(scope);
  const dropped = pending.cancel(scope);
  return { interrupted, droppedPending: dropped.length, droppedPersistent };
}

export function summarizeBatchForHistory(batch: NormalizedMessage[]): string {
  const text = batch
    .map((msg) => msg.content.trim())
    .filter(Boolean)
    .join(' / ')
    .replace(/\s+/g, ' ');
  if (!text) return batch.length > 1 ? `${batch.length} 条消息` : '空消息';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

interface RunBatchDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  scope: string;
  mode: ChatMode;
  runHistory: RunHistory;
  pending: PendingQueue;
  persistentQueue: PersistentQueue;
  durableId?: string;
  autoRetryKeys: AutoRetryKeys;
  onRunRegistered?: () => void;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    media,
    batch,
    controls,
    scope,
    mode,
    runHistory,
    pending,
    persistentQueue,
    durableId,
    autoRetryKeys,
    onRunRegistered,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;
  const workspaceScope = threadId ? chatId : scope;
  const cwd = workspaces.cwdFor(workspaceScope) ?? homedir();
  const historyEntry = runHistory.create(scope, batch, {
    cwd,
    agent: agent.descriptor,
    summary: summarizeBatchForHistory(batch),
  });
  log.info('run', 'timeline', { runId: historyEntry.runId, step: 'intake', batchSize: batch.length });
  log.info('run', 'timeline', { runId: historyEntry.runId, step: 'queue', scope, batchSize: batch.length });

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  let attachments: LocalAttachment[] = [];
  if (resourceItems.length > 0) {
    attachments = await withTimeout(
      'media.resolve',
      MEDIA_RESOLVE_TIMEOUT_MS,
      media.resolve(chatId, resourceItems),
    ).catch((err) => {
      log.fail('media', err, { fallback: 'skip-attachments', count: resourceItems.length });
      return [];
    });
  }
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
  }
  log.info('run', 'timeline', {
    runId: historyEntry.runId,
    step: 'media',
    attachments: attachments.length,
  });

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => m.replyToMessageId)
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await withTimeout(
      'quote.fetch',
      QUOTE_FETCH_TIMEOUT_MS,
      fetchQuotedContext(channel, targetId),
    ).catch((err) => {
      log.fail('quote', err, { messageId: targetId, fallback: 'skip-quote' });
      return undefined;
    });
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  const prompt = buildPrompt(batch, attachments, quotes);
  log.info('prompt', 'built', { promptChars: prompt.length, quotes: quotes.length });
  log.info('run', 'timeline', {
    runId: historyEntry.runId,
    step: 'prompt',
    promptChars: prompt.length,
    quotes: quotes.length,
  });

  const sessionKey = agent.sessionKey;
  let resumeFrom = sessions.resumeFor(scope, cwd, sessionKey);
  if (resumeFrom && agent.canResumeSession?.(resumeFrom) === false) {
    log.warn('session', 'resume-incompatible', { sessionId: resumeFrom, cwd, sessionKey });
    sessions.clear(scope, sessionKey);
    resumeFrom = undefined;
  }
  if (resumeFrom) {
    log.info('session', 'resume', { sessionId: resumeFrom, cwd, sessionKey });
  } else {
    const stale = sessions.getRaw(scope, sessionKey);
    if (stale?.cwd && stale.cwd !== cwd) {
      log.info('session', 'stale-cleared', { staleCwd: stale.cwd, newCwd: cwd, sessionKey });
      sessions.clear(scope, sessionKey);
    } else {
      log.info('session', 'fresh', { cwd, sessionKey });
    }
    resumeFrom = await withTimeout(
      'session.precreate',
      SESSION_PRECREATE_TIMEOUT_MS,
      ensureResumeSession(agent, sessions, scope, cwd),
    ).catch((err) => {
      log.fail('session', err, { cwd, sessionKey, fallback: 'run-without-precreated-session' });
      return undefined;
    });
    if (resumeFrom) {
      log.info('session', 'resume-precreate', { sessionId: resumeFrom, cwd, sessionKey });
    }
  }
  log.info('run', 'timeline', {
    runId: historyEntry.runId,
    step: 'session',
    sessionId: resumeFrom,
    cwd,
  });

  if (durableId && !(await persistentQueue.has(durableId))) {
    log.warn('queue', 'persistent-cancelled-before-agent-run', { scope, durableId });
    runHistory.finish(historyEntry.runId, 'interrupted', '任务已取消');
    return;
  }

  const agentStopGraceMs = getAgentStopGraceMs(controls.cfg);
  const run = agent.run({
    prompt,
    sessionId: resumeFrom,
    cwd,
    poolKey: scope,
    stopGraceMs: agentStopGraceMs,
  });
  const handle = activeRuns.register(scope, run);
  onRunRegistered?.();
  log.info('run', 'timeline', {
    runId: historyEntry.runId,
    step: 'agent',
    sessionId: resumeFrom,
  });

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });
  let finalState: RunState = createInitialState(historyEntry.runId);

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(controls.cfg)) return state;
    const activity =
      state.activity?.kind === 'tool'
        ? state.footer
          ? ({ kind: 'phase', phase: state.footer } as const)
          : undefined
        : state.activity;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool'), activity };
  };

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts: { replyTo: string; replyInThread?: true } = {
    replyTo: lastMsg.messageId,
    ...(threadId ? { replyInThread: true as const } : {}),
  };

  // Add a "Typing" reaction as an instant ack while the agent CLI is still
  // starting up (card footer shows the same phase in more detail).
  const reactionId = await addWorkingReaction(channel, lastMsg.messageId);
  let streamMessageId: string | undefined;

  try {
    if (replyMode === 'card') {
      log.info('run', 'timeline', { runId: historyEntry.runId, step: 'card-stream-start', mode: 'card' });
      const result = await channel.stream(
        chatId,
        {
          card: {
            initial: renderCard(finalState),
            producer: async (ctrl) => {
              finalState = await processAgentStream(
                handle,
                sessions,
                scope,
                cwd,
                agent.sessionKey,
                idleTimeoutMs,
                async (state) => {
                  finalState = state;
                  await withTimeout(
                    'card.update',
                    STREAM_UPDATE_TIMEOUT_MS,
                    ctrl.update(renderCard(filterForPrefs(state))),
                  );
                },
                agentStopGraceMs,
                finalState,
              );
            },
          },
        },
        sendOpts,
      );
      streamMessageId = result.messageId;
      runHistory.update(historyEntry.runId, { streamMessageId });
      log.info('run', 'timeline', {
        runId: historyEntry.runId,
        step: 'card-stream-done',
        mode: 'card',
        messageId: streamMessageId,
      });
      await forceFinalCardUpdate(channel, streamMessageId, filterForPrefs(finalState), 'card', {
        chatId,
        mode,
        cfg: controls.cfg,
      });
    } else if (replyMode === 'markdown') {
      log.info('run', 'timeline', { runId: historyEntry.runId, step: 'card-stream-start', mode: 'markdown' });
      let cutoff: MarkdownRefreshCutoff | undefined;
      let streamMessageIdForRefresh: string | undefined;
      let result: { messageId: string };
      try {
        result = await channel.stream(
          chatId,
          {
            markdown: async (ctrl) => {
              streamMessageIdForRefresh = ctrl.messageId;
              cutoff = createMarkdownRefreshCutoff((markdown) => ctrl.setContent(markdown), Date.now, {
                updateLatest: (markdown) => {
                  const refreshMessageId = streamMessageIdForRefresh;
                  if (!refreshMessageId) return Promise.resolve();
                  const raw = channel.updateCard(refreshMessageId, markdownFinalCard(markdown, finalState));
                  return {
                    operation: withTimeout('markdown.periodic-card-update', FINAL_FLUSH_TIMEOUT_MS, raw),
                    raw,
                  };
                },
              });
              await withTimeout(
                'markdown.initial-flush',
                STREAM_UPDATE_TIMEOUT_MS,
                cutoff.flush(renderText(filterForPrefs(finalState))),
              );
              finalState = await processAgentStream(
                handle,
                sessions,
                scope,
                cwd,
                agent.sessionKey,
                idleTimeoutMs,
                async (state) => {
                  finalState = state;
                  const markdownCutoff = cutoff;
                  if (!markdownCutoff) throw new Error('markdown refresh cutoff was not initialized');
                  await withTimeout(
                    'markdown.update',
                    STREAM_UPDATE_TIMEOUT_MS,
                    markdownCutoff.flush(renderText(filterForPrefs(state)), { final: state.terminal !== 'running' }),
                  );
                },
                agentStopGraceMs,
                finalState,
              );
            },
          },
          sendOpts,
        );
      } finally {
        cutoff?.dispose();
      }
      streamMessageId = result.messageId;
      streamMessageIdForRefresh = streamMessageId;
      runHistory.update(historyEntry.runId, { streamMessageId });
      log.info('run', 'timeline', {
        runId: historyEntry.runId,
        step: 'card-stream-done',
        mode: 'markdown',
        messageId: streamMessageId,
      });
      const finalMarkdownState = filterForPrefs(finalState);
      await forceFinalCardUpdate(channel, streamMessageId, finalMarkdownState, 'markdown', {
        chatId,
        mode,
        cfg: controls.cfg,
      });
      const pendingCutoffUpdate = cutoff?.pendingCutoffUpdate();
      if (pendingCutoffUpdate && streamMessageId) {
        void pendingCutoffUpdate
          .then(() => forceFinalCardUpdate(channel, streamMessageId, finalMarkdownState, 'markdown', {
            chatId,
            mode,
            cfg: controls.cfg,
          }))
          .catch((err) => {
            log.fail('card', err, {
              step: 'final-update-after-cutoff',
              messageId: streamMessageId,
              mode: 'markdown',
              terminal: finalMarkdownState.terminal,
            });
          });
      }
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      finalState = await processAgentStream(
        handle,
        sessions,
        scope,
        cwd,
        agent.sessionKey,
        idleTimeoutMs,
        async (state) => {
          finalState = state;
        },
        agentStopGraceMs,
        finalState,
      );
      const body = renderText(filterForPrefs(finalState));
      if (body.trim()) {
        const sent = (await channel.send(chatId, { markdown: body }, sendOpts)) as { messageId?: string };
        if (sent.messageId) runHistory.update(historyEntry.runId, { streamMessageId: sent.messageId });
      }
    }
  } catch (err) {
    log.fail('stream', err);
    const message = errorMessage(err);
    if (err instanceof TimeoutError) {
      handle.interrupted = true;
      finalState = markInterrupted(finalState);
      await run.stop().catch((stopErr) => {
        log.fail('stream', stopErr, { step: 'stop-after-timeout' });
      });
    } else if (finalState.terminal === 'running') {
      handle.interrupted = true;
      finalState = reduce(finalState, {
        type: 'error',
        message: `卡片更新失败，已降级为普通消息：${message}`,
      });
      await run.stop().catch((stopErr) => {
        log.fail('stream', stopErr, { step: 'stop-after-update-failure' });
      });
    }
    if (err instanceof TimeoutError || finalState.terminal !== 'running') {
      const fallback = renderText(filterForPrefs(finalState));
      if (fallback.trim()) {
        log.info('run', 'timeline', {
          runId: historyEntry.runId,
          step: 'fallback-send',
          reason: message,
        });
        const sent = await channel.send(chatId, { markdown: fallback }, sendOpts).catch((sendErr) => {
          log.fail('stream', sendErr, { step: 'fallback-send' });
          return undefined;
        });
        if (sent?.messageId) runHistory.update(historyEntry.runId, { streamMessageId: sent.messageId });
      }
    }
  } finally {
    runHistory.finish(historyEntry.runId, finalState.terminal, finalState.errorMsg);
    log.info('run', 'timeline', {
      runId: historyEntry.runId,
      step: 'done',
      terminal: finalState.terminal,
      errorMsg: finalState.errorMsg,
    });
    let durableCompleted = !durableId || finalState.terminal === 'running';
    if (durableId && finalState.terminal !== 'running') {
      await persistentQueue.complete(durableId).then(
        () => {
          durableCompleted = true;
        },
        (err) => {
          log.fail('queue', err, { step: 'persistent-complete', scope, durableId });
        },
      );
    }
    if (durableCompleted) {
      await maybeEnqueueAutoRetryForOpaqueSdkError({
        scope,
        batch,
        finalState,
        handleInterrupted: handle.interrupted,
        pending,
        persistentQueue,
        autoRetryKeys,
      }).catch((err) => {
        log.fail('run', err, { step: 'auto-retry-opaque-sdk-error', scope });
      });
    }
    activeRuns.unregister(scope, run);
    if (reactionId) {
      await removeReaction(channel, lastMsg.messageId, reactionId);
    }
    if (finalState.terminal !== 'running') {
      await sendCompletionCheckMessage(channel, chatId, threadId ? sendOpts : undefined);
    }
  }
}

export interface MarkdownRefreshCutoff {
  flush(markdown: string, opts?: { final?: boolean }): Promise<void>;
  pendingCutoffUpdate(): Promise<void> | undefined;
  dispose(): void;
}

type MarkdownLatestUpdate = Promise<void> | { operation: Promise<void>; raw: Promise<void> };

interface MarkdownRefreshCutoffOptions {
  periodicMs?: number;
  updateLatest?: (markdown: string) => MarkdownLatestUpdate;
}

export function createMarkdownRefreshCutoff(
  setContent: (markdown: string) => Promise<void>,
  now: () => number = Date.now,
  opts: MarkdownRefreshCutoffOptions = {},
): MarkdownRefreshCutoff {
  let disposed = false;
  let finalizing = false;
  let cutoffReached = false;
  let cutoffNoticeSent = false;
  let latestMarkdown = '';
  let tail: Promise<void> = Promise.resolve();
  let cutoffUpdate: Promise<void> | undefined;
  let periodicTimer: NodeJS.Timeout | undefined;
  let periodicTail: Promise<void> = Promise.resolve();
  const periodicUpdates = new Set<Promise<unknown>>();
  let latestPeriodicMarkdown = '';
  const periodicMs = opts.periodicMs ?? MARKDOWN_REFRESH_AFTER_CUTOFF_MS;
  const startedAt = now();
  const timer = setTimeout(() => {
    if (disposed || finalizing || cutoffNoticeSent) return;
    cutoffReached = true;
    void Promise.resolve()
      .then(() => sendCutoffNotice())
      .then(() => schedulePeriodicUpdate());
  }, MARKDOWN_REFRESH_CUTOFF_MS);

  const isAtOrAfterCutoff = (): boolean => cutoffReached || now() - startedAt >= MARKDOWN_REFRESH_CUTOFF_MS;

  const clearCutoffTimer = (): void => {
    clearTimeout(timer);
  };

  const warnAndContinue = (err: unknown): void => {
    log.warn('markdown', 'refresh-cutoff-update-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  };

  const clearPeriodicTimer = (): void => {
    if (periodicTimer) clearTimeout(periodicTimer);
    periodicTimer = undefined;
  };

  const schedulePeriodicUpdate = (): void => {
    if (!opts.updateLatest || periodicMs <= 0 || disposed || finalizing || periodicTimer) return;
    periodicTimer = setTimeout(() => {
      periodicTimer = undefined;
      if (disposed || finalizing) return;
      const markdown = latestPeriodicMarkdown;
      const update = periodicTail
        .then(async () => {
          const result = opts.updateLatest?.(markdown);
          if (!result || result instanceof Promise) {
            await result;
            return;
          }
          const raw = result.raw.catch((err: unknown) => warnAndContinue(err));
          periodicUpdates.add(raw);
          void raw.finally(() => {
            periodicUpdates.delete(raw);
          });
          await result.operation;
        })
        .catch((err) => warnAndContinue(err));
      periodicTail = update.then(() => {
        schedulePeriodicUpdate();
      });
    }, periodicMs);
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const task = tail.then(operation, operation);
    tail = task.catch(() => {
      /* keep later markdown updates moving after a failed update */
    });
    return task;
  };

  async function sendCutoffNotice(markdown: string = latestMarkdown): Promise<void> {
    if (disposed || finalizing || cutoffNoticeSent) return;
    cutoffNoticeSent = true;
    if (disposed || finalizing) return;
    const rawUpdate = setContent(withMarkdownRefreshCutoffNote(markdown)).catch((err) => {
      warnAndContinue(err);
    });
    cutoffUpdate = rawUpdate;
    try {
      await withTimeout('markdown.refresh-cutoff-update', STREAM_UPDATE_TIMEOUT_MS, rawUpdate);
    } catch (err) {
      warnAndContinue(err);
    }
  }

  return {
    async flush(markdown: string, opts?: { final?: boolean }): Promise<void> {
      latestMarkdown = markdown;
      latestPeriodicMarkdown = markdown;
      if (opts?.final) {
        clearCutoffTimer();
        clearPeriodicTimer();
        finalizing = true;
        await setContent(markdown);
        disposed = true;
        return;
      }
      if (!isAtOrAfterCutoff()) {
        await enqueue(() => setContent(markdown));
        return;
      }
      cutoffReached = true;
      clearCutoffTimer();
      await sendCutoffNotice(markdown);
      schedulePeriodicUpdate();
    },
    pendingCutoffUpdate(): Promise<void> | undefined {
      const pending = [cutoffUpdate, ...periodicUpdates].filter((update): update is Promise<unknown> => Boolean(update));
      if (pending.length === 0) return undefined;
      return Promise.allSettled(pending).then(() => undefined);
    },
    dispose(): void {
      disposed = true;
      clearCutoffTimer();
      clearPeriodicTimer();
    },
  };
}

function withMarkdownRefreshCutoffNote(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${MARKDOWN_REFRESH_CUTOFF_NOTE}`;
}

export async function maybeEnqueueAutoRetryForOpaqueSdkError(opts: {
  scope: string;
  batch: NormalizedMessage[];
  finalState: RunState;
  handleInterrupted: boolean;
  pending: PendingQueue;
  persistentQueue?: PersistentQueue;
  autoRetryKeys: AutoRetryKeys;
}): Promise<boolean> {
  const { scope, batch, finalState, handleInterrupted, pending, persistentQueue, autoRetryKeys } = opts;
  const key = autoRetryKey(scope, batch);
  if (
    !shouldAutoRetryOpaqueSdkError(finalState, handleInterrupted, pending.queuedSize(scope)) ||
    autoRetryKeys.has(key)
  ) {
    return false;
  }

  rememberAutoRetryKey(autoRetryKeys, key);
  const retryBatch = batch.map((msg) => ({ ...msg }));
  let record;
  if (persistentQueue) {
    try {
      record = await persistentQueue.enqueue(scope, retryBatch);
    } catch (err) {
      log.fail('run', err, { step: 'auto-retry-persistent-enqueue', scope, runId: finalState.runId });
      return false;
    }
  }
  pending.pushBatch(scope, retryBatch, record ? { durableId: record.id } : undefined);
  log.warn('run', 'auto-retry-opaque-sdk-error', {
    scope,
    batchSize: batch.length,
    runId: finalState.runId,
    durableId: record?.id,
    errorMsg: finalState.errorMsg,
  });
  return true;
}

export function shouldAutoRetryOpaqueSdkError(
  finalState: RunState,
  handleInterrupted: boolean,
  queuedPending: number,
): boolean {
  return (
    finalState.terminal === 'error' &&
    !handleInterrupted &&
    queuedPending === 0 &&
    isOpaqueCursorSdkRunError(finalState.errorMsg)
  );
}

function isOpaqueCursorSdkRunError(message: string | undefined): boolean {
  if (!message) return false;
  return (
    message.includes('sdk run failed') &&
    message.includes('status=error') &&
    message.includes('Cursor returned no error detail')
  );
}

function autoRetryKey(scope: string, batch: NormalizedMessage[]): string {
  const ids = batch.map((msg) => msg.messageId || `${msg.chatId}:${msg.content}`).join(',');
  return `${scope}:${ids}`;
}

function rememberAutoRetryKey(keys: AutoRetryKeys, key: string): void {
  keys.add(key);
  while (keys.size > MAX_AUTO_RETRY_KEYS) {
    const oldest = keys.values().next().value;
    if (!oldest) break;
    keys.delete(oldest);
  }
}

interface FinalCardUpdateOptions {
  chatId: string;
  mode: ChatMode;
  cfg: AppConfig;
}

async function forceFinalCardUpdate(
  channel: LarkChannel,
  messageId: string | undefined,
  state: RunState,
  mode: 'card' | 'markdown',
  opts: FinalCardUpdateOptions,
): Promise<void> {
  if (!messageId || state.terminal === 'running') return;
  const card = mode === 'markdown' ? markdownFinalCard(renderText(state), state) : renderCard(state);
  try {
    await withTimeout('final-card-update', FINAL_FLUSH_TIMEOUT_MS, channel.updateCard(messageId, card));
    log.info('card', 'final-update', {
      messageId,
      mode,
      terminal: state.terminal,
      chars: mode === 'markdown' ? renderText(state).length : undefined,
    });
    await markGroupChatUnreadAfterFinalCard(channel, opts.chatId, opts.mode, opts.cfg);
  } catch (err) {
    log.fail('card', err, { step: 'final-update', messageId, mode, terminal: state.terminal });
  }
}

async function markGroupChatUnreadAfterFinalCard(
  channel: LarkChannel,
  chatId: string,
  mode: ChatMode,
  cfg: AppConfig,
): Promise<void> {
  if (!getMarkGroupUnreadOnFinalCard(cfg) || mode === 'p2p') return;
  const rawClient = channel.rawClient as typeof channel.rawClient & {
    formatPayload?: (payload?: {
      path?: Record<string, unknown>;
      data?: Record<string, unknown>;
    }) => Promise<{
      headers: Record<string, unknown>;
      params: Record<string, unknown>;
      data: Record<string, unknown>;
      path: Record<string, unknown>;
    }>;
    httpInstance?: {
      request(opts: {
        url: string;
        method: string;
        headers?: Record<string, unknown>;
        params?: Record<string, unknown>;
        data?: Record<string, unknown>;
      }): Promise<unknown>;
    };
    domain?: string;
  };
  const chat = (rawClient.im.v1 as { chat?: typeof rawClient.im.v1.chat & {
    membersMePatch?: (payload: { path: { chat_id: string }; data: { unread: boolean } }) => Promise<unknown>;
  } }).chat;
  try {
    if (chat?.membersMePatch) {
      await withTimeout('mark-chat-unread', FINAL_FLUSH_TIMEOUT_MS, chat.membersMePatch({
        path: { chat_id: chatId },
        data: { unread: true },
      }));
    } else if (rawClient.formatPayload && rawClient.httpInstance && rawClient.domain) {
      const { headers, params, data, path } = await rawClient.formatPayload({
        path: { chat_id: chatId },
        data: { unread: true },
      });
      await withTimeout('mark-chat-unread', FINAL_FLUSH_TIMEOUT_MS, rawClient.httpInstance.request({
        url: `${rawClient.domain}/open-apis/im/v1/chats/${encodeURIComponent(String(path.chat_id))}/members/me`,
        method: 'PATCH',
        headers,
        params,
        data,
      }));
    } else {
      log.warn('card', 'mark-chat-unread-unavailable', { chatId, mode });
      return;
    }
    log.info('card', 'mark-chat-unread', { chatId, mode });
  } catch (err) {
    log.fail('card', err, { step: 'mark-chat-unread', chatId, mode });
  }
}

function markdownFinalCard(markdown: string, state: RunState): object {
  const elements: object[] = [{ tag: 'markdown', content: markdown || '_（未返回内容）_' }];
  if (state.runId && (state.terminal === 'error' || state.terminal === 'idle_timeout')) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '一键重试' },
      type: 'default',
      behaviors: [{ type: 'callback', value: { cmd: 'retry', run_id: state.runId } }],
    });
  }
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: finalSummary(state) },
    },
    body: {
      elements,
    },
  };
}

function finalSummary(state: RunState): string {
  if (state.terminal === 'done') return '已完成';
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  return '运行中';
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
export async function processAgentStream(
  handle: RunHandle,
  sessions: SessionStore,
  scope: string,
  cwd: string,
  sessionKey: string,
  idleTimeoutMs: number | undefined,
  flush: (state: RunState) => Promise<void>,
  postDoneExitGraceMs = POST_DONE_EXIT_GRACE_MS,
  startState?: RunState,
): Promise<RunState> {
  let state: RunState = startState ?? createInitialState();

  // Idle watchdog: claude going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // Tool calls count as activity when they start/finish, but a tool that never
  // returns is still indistinguishable from a stuck backend to the user. Keep
  // the watchdog armed during in-flight tools so configured timeouts also
  // recover "tool running" cards that would otherwise stay stale forever.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  let progressTimer: NodeJS.Timeout | undefined;
  let flushTail: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;
  const inFlightTools = new Set<string>();
  const stopRun = (): Promise<void> => {
    stopping ??= handle.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return stopping;
  };
  const enqueueFlush = (snapshot: RunState): Promise<void> => {
    const task = flushTail.then(
      () => flush(snapshot),
      () => flush(snapshot),
    );
    flushTail = task.catch(() => {
      /* keep later flushes moving after a failed update */
    });
    return task;
  };
  const flushFromEventLoop = async (): Promise<void> => {
    try {
      await enqueueFlush(state);
    } catch (err) {
      throw new FlushFailure(err);
    }
  };
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void stopRun();
    }, idleTimeoutMs);
  };
  armOrPauseIdle();
  progressTimer = setInterval(() => {
    if (state.terminal !== 'running' || handle.interrupted) return;
    const snapshot = { ...state, updatedAt: Date.now() };
    void withTimeout('progress-refresh', STREAM_UPDATE_TIMEOUT_MS, enqueueFlush(snapshot)).catch((err) => {
      log.warn('card', 'progress-refresh-failed', {
        scope,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, PROGRESS_REFRESH_MS);

  try {
    for await (const evt of handle.run.events) {
      if (handle.interrupted) break;

      // Track tool flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use opens a window; tool_result
      // closes it. Other event types are bookkept after the if/else.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      }
      armOrPauseIdle();

      if (evt.type === 'system') {
        if (evt.sessionId) {
          const effectiveCwd = evt.cwd ?? cwd;
          sessions.set(scope, sessionKey, evt.sessionId, effectiveCwd);
          log.info('session', 'set', { sessionId: evt.sessionId, sessionKey });
        }
        const prevFooter = state.footer;
        state = markAgentReady(state);
        if (state.footer !== prevFooter) {
          log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
          await flushFromEventLoop();
        }
        continue;
      }
      if (evt.type === 'usage') {
        if (evt.costUsd !== undefined) {
          log.info('agent', 'usage', { costUsd: Number(evt.costUsd.toFixed(4)) });
        }
        continue;
      }
      if (evt.type === 'done' && evt.sessionId) {
        sessions.set(scope, sessionKey, evt.sessionId, cwd);
        log.info('session', 'set', { sessionId: evt.sessionId, sessionKey });
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flushFromEventLoop();
      // Stop iterating as soon as we have a terminal state. Some claude
      // versions don't close stdout immediately after the result event, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } catch (err) {
    if (err instanceof FlushFailure) throw err.cause;
    log.fail('agent-stream', err);
    if (state.terminal === 'running') {
      state = reduce(state, { type: 'error', message: formatAgentStreamError(err) });
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (progressTimer) clearInterval(progressTimer);
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "claude finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { terminal: state.terminal, interrupted: handle.interrupted });
  try {
    await withTimeout('final-flush', FINAL_FLUSH_TIMEOUT_MS, enqueueFlush(state));
  } finally {
    // Reap the subprocess. Two regimes:
    //  - Interrupted (user /stop, idle watchdog, disconnect): stop() was already
    //    fire-and-forgotten by whoever set handle.interrupted; this awaits it.
    //  - Natural done: stream-json emits `result` ~1ms before claude actually
    //    closes stdout (telemetry flush). Wait it out so the run exits with
    //    code 0; only SIGTERM as a hung-process safety net.
    if (handle.interrupted) {
      await stopRun();
    } else {
      const exited = await handle.run.waitForExit(postDoneExitGraceMs);
      if (!exited) {
        log.warn('agent', 'post-done-timeout', { graceMs: postDoneExitGraceMs });
        await handle.run.stop();
      }
    }
  }
  return state;
}

/**
 * Fallback wait for an agent to close stdout after a terminal event before
 * forcing a SIGTERM. Runtime calls use the configured agent stop grace so
 * slower Cursor cleanup is not killed by this legacy 2s default.
 */
const POST_DONE_EXIT_GRACE_MS = 2000;

class FlushFailure {
  constructor(readonly cause: unknown) {}
}

function errorField(err: unknown, key: 'code' | 'rawMessage'): string | number | undefined {
  if (!err || typeof err !== 'object' || !(key in err)) return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}

function formatAgentStreamError(err: unknown): string {
  const parts = [`agent stream error: ${errorMessage(err)}`];
  const raw = errorField(err, 'rawMessage');
  const code = errorField(err, 'code');
  if (raw && raw !== errorMessage(err)) parts.push(`raw=${raw}`);
  if (code !== undefined) parts.push(`code=${code}`);
  return parts.join(' | ');
}

function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
): string {
  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  const texts = batch
    .map((m) => stripAttachmentRefs(m.content, fileKeys).trim())
    .filter(Boolean);
  const ctxHeader = buildBridgeContextHeader(batch);
  const quoteBlock = renderQuotedBlock(quotes);

  // Order: <bridge_context> (metadata) → <quoted_message>(s) (what user is
  // pointing at) → user text + attachments (what they're asking).
  const prefixParts = [ctxHeader, quoteBlock].filter(Boolean);
  const prefix = prefixParts.length > 0 ? `${prefixParts.join('\n\n')}\n\n` : '';

  if (attachments.length === 0) {
    return `${prefix}${texts.join('\n\n')}`;
  }

  const attachLines = attachments.map((a) => {
    const label =
      a.kind === 'image'
        ? '图片'
        : a.kind === 'audio'
          ? '音频'
          : a.kind === 'video'
            ? '视频'
            : '文件';
    const name = a.originalName ? ` (${a.originalName})` : '';
    return `- ${a.path}${name} — ${label}`;
  });
  const userPart = texts.length > 0 ? texts.join('\n\n') : '请看下面的附件。';
  return `${prefix}${userPart}\n\n附件（本地路径）：\n${attachLines.join('\n')}`;
}

function buildBridgeContextHeader(batch: NormalizedMessage[]): string {
  const m = batch[0];
  if (!m) return '';
  const lines = [
    '<bridge_context>',
    `chat_id: ${m.chatId}`,
    `chat_type: ${m.chatType}`,
    `sender_id: ${m.senderId}`,
  ];
  if (m.senderName) lines.push(`sender_name: ${m.senderName}`);
  if (m.threadId) lines.push(`thread_id: ${m.threadId}`);
  lines.push('</bridge_context>');
  return lines.join('\n');
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n');
}
