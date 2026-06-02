import type { AgentDescriptor } from '../agent/types';
import type { RunHistoryEntry } from '../bot/run-history';
import type { DiagnosticStatus, SetupDiagnosticsResult } from '../doctor/setup';

interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置，使用 $HOME)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作空间。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作空间'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作空间', elements);
}

export interface StatusInfo {
  cwd: string;
  sessionId?: string;
  sessionStale: boolean;
  agentName: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
  agent?: AgentDescriptor;
  latestRun?: RunHistoryEntry;
}

export interface RunsCardInfo {
  cwd: string;
  entries: RunHistoryEntry[];
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : '(无)';
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `📁 **cwd**: \`${escapeCode(info.cwd)}\``,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
  ];
  if (info.agent) {
    lines.push(`🧩 **runtime**: ${escapeMd(info.agent.runtime)} · \`${escapeCode(info.agent.sessionKey)}\``);
    const capabilities = [
      info.agent.supportsRetry ? 'retry' : '',
      info.agent.supportsWorkers ? 'workers' : '',
    ].filter(Boolean);
    if (capabilities.length > 0) lines.push(`🛠 **能力**: ${capabilities.join(', ')}`);
  }
  if (info.latestRun) {
    lines.push(
      `🧭 **最近运行**: ${terminalIcon(info.latestRun.terminal)} ${escapeMd(info.latestRun.summary)} (${formatAge(Date.now() - info.latestRun.createdAt)}前)`,
    );
    if (info.latestRun.errorMsg) lines.push(`⚠️ **最近失败**: ${escapeMd(info.latestRun.errorMsg)}`);
  }
  const buttons: ButtonSpec[] = [
    { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
    { text: '🔁 恢复会话', value: { cmd: 'resume' } },
    { text: '📂 工作空间', value: { cmd: 'ws.list' } },
    { text: '🧭 最近运行', value: { cmd: 'runs' } },
  ];
  if (info.latestRun) {
    buttons.push({ text: '运行详情', value: { cmd: 'runs.detail', run_id: info.latestRun.runId } });
  }
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions(buttons),
  ]);
}

export function runsCard(info: RunsCardInfo): object {
  const elements: object[] = [divMd(`当前 cwd：\`${escapeCode(info.cwd)}\``)];
  if (info.entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无运行记录。发送一条消息让 agent 开始工作，之后可在这里查看最近任务。'));
    elements.push(divMd('需要命令列表可发送 `/help`。'));
    return shell('🧭 最近运行', elements);
  }

  elements.push(HR);
  info.entries.forEach((entry, index) => {
    elements.push(runEntryLine(entry));
    const buttons: ButtonSpec[] = [
      { text: '详情', value: { cmd: 'runs.detail', run_id: entry.runId } },
    ];
    if (entry.terminal === 'running') {
      buttons.unshift({ text: '终止', value: { cmd: 'stop' }, style: 'danger' });
    } else if (entry.terminal === 'error' || entry.terminal === 'idle_timeout') {
      buttons.unshift({ text: '重试', value: { cmd: 'retry', run_id: entry.runId }, style: 'primary' });
    }
    elements.push(actions(buttons));
    if (index < info.entries.length - 1) elements.push(HR);
  });
  return shell('🧭 最近运行', elements);
}

export function runDetailCard(entry: RunHistoryEntry): object {
  const lines = [
    `**run**: \`${escapeCode(entry.runId)}\``,
    `**状态**: ${terminalText(entry.terminal)}`,
    `**agent**: ${escapeMd(entry.agent.label)} · ${escapeMd(entry.agent.runtime)} · \`${escapeCode(entry.agent.sessionKey)}\``,
    `**cwd**: \`${escapeCode(entry.cwd)}\``,
    `**创建**: ${timeText(entry.createdAt)} · **更新**: ${timeText(entry.updatedAt)}`,
    `**摘要**: ${escapeMd(entry.summary)}`,
    entry.streamMessageId ? `**消息**: \`${escapeCode(entry.streamMessageId)}\`` : '',
    entry.errorMsg ? `**失败原因**: ${escapeMd(entry.errorMsg)}` : '',
  ].filter(Boolean);
  const buttons: ButtonSpec[] = [{ text: '返回最近运行', value: { cmd: 'runs' } }];
  if (entry.terminal === 'running') {
    buttons.unshift({ text: '终止', value: { cmd: 'stop' }, style: 'danger' });
  } else if (entry.terminal === 'error' || entry.terminal === 'idle_timeout') {
    buttons.unshift({ text: '重试', value: { cmd: 'retry', run_id: entry.runId }, style: 'primary' });
  }
  return shell('🧭 运行详情', [divMd(lines.join('\n')), HR, actions(buttons)]);
}

export function setupDiagnosticsCard(result: SetupDiagnosticsResult): object {
  const elements: object[] = [divMd(`**${escapeMd(result.summary.title)}**`)];
  elements.push(HR);
  result.checks.forEach((check, index) => {
    const lines = [
      `${diagnosticIcon(check.status)} **${escapeMd(check.title)}**`,
      escapeMd(check.detail),
      check.suggestion ? `建议：${escapeMd(check.suggestion)}` : '',
    ].filter(Boolean);
    elements.push(divMd(lines.join('\n')));
    if (index < result.checks.length - 1) elements.push(HR);
  });
  return shell('🩺 Setup 自检', elements);
}

function runEntryLine(entry: RunHistoryEntry): object {
  const pieces = [
    `${terminalIcon(entry.terminal)} ${terminalText(entry.terminal)} · **${escapeMd(entry.summary)}**`,
    `\`${escapeCode(shortRunId(entry.runId))}\` · ${escapeMd(entry.agent.label)} / ${escapeMd(entry.agent.runtime)} · ${formatAge(Date.now() - entry.createdAt)}前`,
  ];
  if (entry.errorMsg) pieces.push(`失败原因：${escapeMd(entry.errorMsg)}`);
  return divMd(pieces.join('\n'));
}

function terminalIcon(terminal: RunHistoryEntry['terminal']): string {
  if (terminal === 'done') return '✅';
  if (terminal === 'running') return '⏳';
  if (terminal === 'interrupted') return '⏹';
  if (terminal === 'idle_timeout') return '⏱';
  return '⚠️';
}

function diagnosticIcon(status: DiagnosticStatus): string {
  if (status === 'pass') return '✅';
  if (status === 'warn') return '⚠️';
  if (status === 'fail') return '❌';
  return 'ℹ️';
}

function terminalText(terminal: RunHistoryEntry['terminal']): string {
  if (terminal === 'done') return '已完成';
  if (terminal === 'running') return '运行中';
  if (terminal === 'interrupted') return '已中断';
  if (terminal === 'idle_timeout') return '已超时';
  return '出错';
}

function shortRunId(runId: string): string {
  return runId.length > 16 ? `${runId.slice(0, 13)}…` : runId;
}

function timeText(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export interface ResumeEntry {
  sessionId: string;
  preview: string;
  relTime: string;
  lineCount: number;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${e.sessionId.slice(0, 8)}…\` · ${e.relTime} · ${e.lineCount} 条`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

export function helpCard(): object {
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**',
        '',
        '- `/new` `/reset` — 清空当前 chat 的会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- `/new worktree <name>` — 创建 git worktree，并新建绑定群聊',
        '- `/clear [--force]` — 清理当前 worktree 群的本地状态',
        '- `/resume [N]` — 列出并恢复历史会话（最多 N 条）',
        '- `/cd <path>` — 切换工作目录（会重置 session）',
        '- `/ws list` — 列出命名工作空间（卡片 + 按钮）',
        '- `/ws save <name>` `/ws use <name>` `/ws remove <name>` — 保存 / 切换 / 删除工作空间',
        '- `/account` — 查看当前应用；`/account change` 换 appId/secret 并重连',
        '- `/config` — 调整偏好（消息回复方式、工具调用显示）',
        '- `/status` — 当前状态',
        '- `/runs [run-id]` — 查看最近运行、失败原因、重试/终止入口和单次详情',
        '- `/backend [key|default]` — 查看或切换当前 chat 的 agent backend',
        '- `/stop` — 结束当前正在跑的任务（也可点卡片底部 ⏹ 终止 按钮）',
        '- `/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认',
        '- `/retry <run-id>` — 重放最近失败或超时的任务',
        '- `/shell <command>` — 在当前 cwd 执行 shell 命令并回传输出（管理员命令）',
        '- `/workers` — 查看 Cursor SDK worker pool 健康状态',
        '- `/ps` — 列出本机所有 bot,标识当前正在回复的那个',
        '- `/exit <id|#>` — 关掉指定 bot(用 `/ps` 看 id/序号)',
        '- `/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)',
        '- `/doctor [description]` — 把日志和描述喂给 agent 自助诊断',
        '- `/doctor setup` — 运行非变更性的本地 setup 自检',
        '- `/doctor workers` — 直接查看 SDK worker pool 状态',
        '- `/help` — 本帮助',
        '',
        '其他内容直接交给 Claude。',
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作空间', value: { cmd: 'ws.list' } },
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([\\*_`\[\]()<>])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
