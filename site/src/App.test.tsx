import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import App from './App';

function renderAt(hash = '') {
  window.location.hash = hash;
  return render(<App />);
}

describe('homepage shell', () => {
  test('uses a unified dark theme instead of a split light lower section', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

    expect(css).toContain('linear-gradient(180deg, #08101d 0%, #050816 38%, #0b1220 100%)');
    expect(css).not.toContain('#ede7db');
  });

  test('defaults to Chinese and switches to English', async () => {
    const user = userEvent.setup();
    renderAt();

    expect(
      screen.getByRole('heading', { name: '把本地 coding agents 接进飞书工作台' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'EN' }));

    expect(
      screen.getByRole('heading', { name: 'Run local coding agents from Lark' }),
    ).toBeInTheDocument();
  });

  test('shows the default Chinese hero quickstart and backend chips', () => {
    renderAt();

    const heroCockpit = screen.getByLabelText('Command center preview');
    expect(within(heroCockpit).getByText('npx -y lark-agent-bridge@latest start')).toBeInTheDocument();
    expect(within(heroCockpit).getByText('Claude Code')).toBeInTheDocument();
    expect(within(heroCockpit).getByText('Cursor Agent')).toBeInTheDocument();
    expect(within(heroCockpit).getByText('Codex')).toBeInTheDocument();
    expect(within(heroCockpit).getByText('每个 chat 保留独立 session')).toBeInTheDocument();
  });

  test('shows product proof directly below the hero', () => {
    renderAt();

    expect(screen.getByRole('heading', { name: '运行界面证据' })).toBeInTheDocument();
    expect(screen.getByAltText('桥接消息流界面')).toBeInTheDocument();
    expect(screen.getByAltText('终端扫码向导界面')).toBeInTheDocument();
    expect(screen.getByAltText('运行状态与运维界面')).toBeInTheDocument();
  });

  test('explains the workbench capabilities and the bridge architecture', () => {
    renderAt();

    expect(screen.getByRole('heading', { name: '为什么它是工程工作台，而不是普通 bot' })).toBeInTheDocument();
    expect(screen.getByText('多后端切换')).toBeInTheDocument();
    expect(screen.getByText('工作区和 session 路由')).toBeInTheDocument();
    expect(screen.getByText('运行恢复与诊断')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '桥是怎么工作的' })).toBeInTheDocument();
    expect(screen.getByText('Lark / Feishu')).toBeInTheDocument();
    expect(screen.getByText('本地 lark-agent-bridge')).toBeInTheDocument();
    expect(screen.getByText('Claude / Cursor / Codex')).toBeInTheDocument();
    expect(screen.getByText('本地仓库与命令')).toBeInTheDocument();
  });

  test('shows quickstart, operator commands, and repo/doc links', () => {
    renderAt();

    expect(screen.getByRole('heading', { name: '快速开始与运维入口' })).toBeInTheDocument();
    const quickstartSection = screen.getByRole('heading', { name: '快速开始与运维入口' }).closest('section');
    expect(quickstartSection).not.toBeNull();
    expect(within(quickstartSection!).getByText('/ws')).toBeInTheDocument();
    expect(within(quickstartSection!).getByText('/new worktree')).toBeInTheDocument();
    expect(within(quickstartSection!).getByText('/workers')).toBeInTheDocument();
    expect(within(quickstartSection!).getByRole('link', { name: '中文 README' })).toHaveAttribute(
      'href',
      'https://github.com/fangpin/lark-agent-bridge/blob/main/README.zh.md',
    );
    expect(within(quickstartSection!).getByRole('link', { name: 'English README' })).toHaveAttribute(
      'href',
      'https://github.com/fangpin/lark-agent-bridge/blob/main/README.md',
    );
    const primaryNav = document.querySelector('nav[aria-label="Primary"]');
    expect(primaryNav).not.toBeNull();
    expect(within(primaryNav as HTMLElement).getByRole('link', { name: 'GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/fangpin/lark-agent-bridge',
    );
  });

  test('renders the Markdown-backed docs overview from the site route', () => {
    renderAt('#docs');

    expect(screen.getByRole('heading', { name: '系统总览与代码边界' })).toBeInTheDocument();
    expect(screen.getByText('docs/site/zh/overview.md')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '消息接入与运行编排' })).toBeInTheDocument();
  });

  test('keeps docs chapters mirrored across Chinese and English', async () => {
    const user = userEvent.setup();
    renderAt('#docs/orchestration');

    expect(screen.getByRole('heading', { name: '消息接入与运行编排' })).toBeInTheDocument();
    expect(screen.getByText('docs/site/zh/orchestration.md')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'EN' }));

    expect(screen.getByRole('heading', { name: 'Message Intake and Run Orchestration' })).toBeInTheDocument();
    expect(screen.getByText('docs/site/en/orchestration.md')).toBeInTheDocument();
  });
});
