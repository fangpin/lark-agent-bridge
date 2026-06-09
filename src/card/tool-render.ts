import type { ToolEntry } from './run-state';

const HEADER_SUMMARY_MAX = 80;
const BODY_FIELD_MAX = 600;
const OUTPUT_MAX = 1200;
/**
 * Cumulative cap on a tool's full body markdown (input + output + code fences
 * + headers). Even with per-field caps, pathological tools (many input
 * fields + maxed-out output) can stack to multi-KB bodies which, multiplied
 * across panels, push the card past Feishu's per-element size limit. This
 * is the last belt across the whole rendered body string.
 */
const BODY_TOTAL_MAX = 2500;

export function toolHeaderText(tool: ToolEntry): string {
  const icon = tool.status === 'done' ? '✅' : tool.status === 'error' ? '❌' : '⏳';
  const summary = summarizeInput(tool.name, tool.input);
  const name = displayName(tool.name);
  return summary ? `${icon} **${name}** — ${summary}` : `${icon} **${name}**`;
}

export function isLowSignalTool(tool: ToolEntry): boolean {
  if (tool.status === 'error') return false;
  const name = canonicalToolName(tool.name);
  if (name === 'read' || name === 'glob' || name === 'grep') return true;
  if (name === 'shell') return isContextCommand(tool.input);
  return false;
}

export function toolBodyMd(tool: ToolEntry): string {
  const parts: string[] = [];
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);

  if (tool.output) {
    const truncated = truncate(tool.output, OUTPUT_MAX);
    if (tool.status === 'error') {
      parts.push(`**Error**\n\`\`\`\n${truncated}\n\`\`\``);
    } else if (tool.name === 'Bash') {
      parts.push(renderBashOutput(truncated));
    } else {
      parts.push(`**Output**\n\`\`\`\n${truncated}\n\`\`\``);
    }
  } else if (tool.status === 'running') {
    parts.push('_运行中…_');
  }

  const body = parts.join('\n\n');
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}…\n\n_（body 已截断,完整内容查 \`/doctor\` 或日志）_`;
}

function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const pick = (key: string, max = HEADER_SUMMARY_MAX): string => {
    const v = rec[key];
    if (typeof v !== 'string') return '';
    const oneLine = v.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  };
  const path = (): string => pick('file_path') || pick('path');
  switch (canonicalToolName(name)) {
    case 'shell':
      return pick('command');
    case 'read':
    case 'edit':
    case 'write':
    case 'notebook_edit':
      return shortenPath(path());
    case 'grep': {
      const pat = pick('pattern', 40);
      const where = pick('path', 30);
      return where ? `${pat} in ${shortenPath(where)}` : pat;
    }
    case 'glob':
      return pick('pattern') || pick('glob_pattern');
    case 'web_fetch':
      return pick('url');
    case 'web_search':
      return pick('query', 60) || pick('search_term', 60);
    case 'skill':
      return pick('skill') || pick('name');
    case 'agent':
    case 'task':
      return pick('description') || pick('subagent_type');
    default:
      return pick('command') || path() || pick('query') || pick('search_term');
  }
}

function renderInput(tool: ToolEntry): string {
  const input = tool.input;
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const str = (k: string): string => (typeof rec[k] === 'string' ? (rec[k] as string) : '');

  switch (canonicalToolName(tool.name)) {
    case 'shell': {
      const cmd = str('command');
      return cmd ? `**Command**\n\`\`\`bash\n${truncate(cmd, BODY_FIELD_MAX)}\n\`\`\`` : '';
    }
    case 'read':
    case 'edit':
    case 'write':
    case 'notebook_edit': {
      const fp = str('file_path') || str('path');
      return fp ? `**File** \`${fp}\`` : '';
    }
    case 'grep': {
      const lines: string[] = [];
      if (str('pattern')) lines.push(`**Pattern** \`${str('pattern')}\``);
      if (str('path')) lines.push(`**Path** \`${str('path')}\``);
      return lines.join('\n');
    }
    case 'web_fetch':
      return str('url') ? `**URL** ${str('url')}` : '';
    case 'web_search': {
      const query = str('query') || str('search_term');
      return query ? `**Query** \`${truncate(query, BODY_FIELD_MAX)}\`` : '';
    }
    default:
      return '';
  }
}

function renderBashOutput(out: string): string {
  // Some agents wrap stdout/stderr in xml-like tags; keep simple and just dump.
  return `**Output**\n\`\`\`\n${out}\n\`\`\``;
}

function shortenPath(p: string): string {
  if (!p) return p;
  // Trim home prefix for readability.
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function displayName(name: string): string {
  switch (canonicalToolName(name)) {
    case 'shell':
      return '终端';
    case 'read':
      return '读取文件';
    case 'grep':
      return '搜索';
    case 'glob':
      return '查找文件';
    case 'edit':
      return '编辑文件';
    case 'write':
      return '写入文件';
    case 'web_search':
      return '网页搜索';
    case 'web_fetch':
      return '读取网页';
    default:
      return name;
  }
}

function canonicalToolName(name: string): string {
  const n = name.replace(/^functions\./, '').replace(/[_\s-]/g, '').toLowerCase();
  if (n === 'bash' || n === 'shell') return 'shell';
  if (n === 'read' || n === 'readfile') return 'read';
  if (n === 'grep' || n === 'rg' || n === 'ripgrep') return 'grep';
  if (n === 'glob') return 'glob';
  if (n === 'edit' || n === 'applypatch') return 'edit';
  if (n === 'write') return 'write';
  if (n === 'notebookedit' || n === 'editnotebook') return 'notebook_edit';
  if (n === 'websearch') return 'web_search';
  if (n === 'webfetch') return 'web_fetch';
  if (n === 'skill') return 'skill';
  if (n === 'agent' || n === 'task' || n === 'subagent') return 'agent';
  return name.toLowerCase();
}

function isContextCommand(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== 'string') return false;
  const normalized = command.trim().replace(/\s+/g, ' ');
  return /^(git (status|log|diff|show)|ls\b|pwd\b|rg\b|npm (run )?typecheck\b)/.test(normalized);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
