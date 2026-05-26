import type { ActivityEntry, FooterStatus } from './run-state';
import { isLowSignalTool, toolHeaderText } from './tool-render';

export function activityText(activity: ActivityEntry | undefined, footer: FooterStatus): string | undefined {
  if (activity?.kind === 'tool') {
    if (isLowSignalTool(activity.tool)) {
      return footer ? phaseText(footer, '正在准备上下文') : undefined;
    }
    return toolHeaderText(activity.tool);
  }
  if (activity?.kind === 'phase') {
    return phaseText(activity.phase, activity.label, activity.detail);
  }
  if (!footer) return undefined;
  return phaseText(footer);
}

function phaseText(
  phase: Exclude<FooterStatus, null>,
  label?: string,
  detail?: string,
): string {
  const fallback =
    phase === 'starting'
      ? '正在启动 Agent'
      : phase === 'thinking'
        ? '正在思考'
        : phase === 'tool_running'
          ? '正在调用工具'
          : '正在输出回答';
  const icon =
    phase === 'starting' ? '🚀' : phase === 'thinking' ? '🧠' : phase === 'tool_running' ? '🧰' : '✍️';
  const main = label || fallback;
  return detail && detail !== main ? `${icon} ${main} — ${detail}` : `${icon} ${main}`;
}
