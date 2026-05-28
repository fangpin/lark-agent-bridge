import type { Block, RunState, ToolEntry } from './run-state';
import { renderTodoMarkdown, todoSummaryText } from './todo-board-render';
import { isLowSignalTool, toolHeaderText } from './tool-render';

const MAX_TOOL_LINES = 8;
const MAX_RENDERED_CHARS = 18_000;

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState): string {
  const parts: string[] = [];
  let visibleToolLines = 0;
  let hiddenToolLines = 0;

  for (const block of state.blocks) {
    const piece = renderBlock(block, visibleToolLines < MAX_TOOL_LINES);
    if (piece) parts.push(piece);
    if (block.kind === 'tool' && !isLowSignalTool(block.tool)) {
      if (piece) visibleToolLines++;
      else hiddenToolLines++;
    }
  }

  if (hiddenToolLines > 0) {
    parts.push(`_已折叠 ${hiddenToolLines} 个工具步骤，完整细节可通过 /doctor 查看。_`);
  }

  if (state.todos.length > 0) {
    parts.push(`📋 **任务看板** · ${todoSummaryText(state.todos)}\n${renderTodoMarkdown(state.todos)}`);
  }

  if (state.terminal === 'running' && state.runId) {
    parts.push(`_运行 ${ageText(Date.now() - state.startedAt)} · 最近活动 ${ageText(Date.now() - state.lastActivityAt)}前_`);
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'done') {
    parts.push('_✅ 已完成_');
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state.footer));
  }

  return truncateRendered(parts.join('\n\n'));
}

function renderBlock(block: Block, includeTool: boolean): string {
  if (block.kind === 'text') {
    return block.content.trim();
  }
  if (isLowSignalTool(block.tool)) return '';
  if (!includeTool) return '';
  return toolLine(block.tool);
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

function footerLine(status: 'starting' | 'thinking' | 'tool_running' | 'streaming'): string {
  if (status === 'starting') return '_🚀 正在启动 Agent…_';
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}

function ageText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const min = minutes % 60;
  return min ? `${hours}h${min}m` : `${hours}h`;
}

function truncateRendered(text: string): string {
  if (text.length <= MAX_RENDERED_CHARS) return text;
  return `${text.slice(0, MAX_RENDERED_CHARS)}\n\n_（内容过长，已截断；完整细节可通过 /doctor 查看。）_`;
}
