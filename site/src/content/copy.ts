import larkCardProof from '../assets/proof/lark-card.png';
import opsPanelProof from '../assets/proof/ops-panel.png';
import qrWizardProof from '../assets/proof/qr-wizard.png';

export type Locale = 'zh' | 'en';

interface HeroCopy {
  eyebrow: string;
  title: string;
  body: string;
  quickstartLabel: string;
  quickstartCommand: string;
  primaryCtaLabel: string;
  primaryCtaHref: string;
  secondaryCtaLabel: string;
  secondaryCtaHref: string;
  backendBadges: string[];
  workspaceNotes: string[];
}

interface ProofCopy {
  heading: string;
  body: string;
  items: { alt: string; caption: string; src: string }[];
}

interface CapabilityCopy {
  heading: string;
  body: string;
  items: { title: string; body: string; chips: string[] }[];
}

interface ArchitectureCopy {
  heading: string;
  body: string;
  nodes: string[];
}

interface QuickstartCopy {
  heading: string;
  body: string;
  command: string;
  setupSteps: string[];
  commands: string[];
  docs: { label: string; href: string }[];
}

interface FooterCopy {
  links: { label: string; href: string }[];
  note: string;
}

export interface HomeCopy {
  nav: {
    docsHref: string;
    docsLabel: string;
    githubHref: string;
    githubLabel: string;
  };
  hero: HeroCopy;
  proof: ProofCopy;
  capabilities: CapabilityCopy;
  architecture: ArchitectureCopy;
  quickstart: QuickstartCopy;
  footer: FooterCopy;
}

export const copy: Record<Locale, HomeCopy> = {
  zh: {
    nav: {
      docsHref: '#docs',
      docsLabel: '设计与实现',
      githubHref: 'https://github.com/fangpin/lark-agent-bridge',
      githubLabel: 'GitHub',
    },
    hero: {
      eyebrow: 'Lark / Feishu x Local Coding Agents',
      title: '把本地 coding agents 接进飞书工作台',
      body:
        '在聊天里驱动 Claude Code、Cursor Agent、Codex 和兼容 wrapper，并把 workspace、session、retry、status 这些工程上下文一起带进来。',
      quickstartLabel: '快速开始',
      quickstartCommand: 'npx -y lark-agent-bridge@latest start',
      primaryCtaLabel: '查看 GitHub',
      primaryCtaHref: 'https://github.com/fangpin/lark-agent-bridge',
      secondaryCtaLabel: '阅读设计文档',
      secondaryCtaHref: '#docs',
      backendBadges: ['Claude Code', 'Cursor Agent', 'Codex', 'Wrappers'],
      workspaceNotes: [
        '每个 chat 保留独立 session',
        '支持 workspace 路由与 /new worktree',
        '失败后保留 /retry /workers /doctor',
      ],
    },
    proof: {
      heading: '运行界面证据',
      body: '首屏下面立刻给出真实产品证据：飞书流式卡片、终端扫码绑定、以及运行状态与运维视角。',
      items: [
        { alt: '桥接消息流界面', caption: '飞书 / Lark 中的实时流式卡片', src: larkCardProof },
        { alt: '终端扫码向导界面', caption: '首次启动的终端扫码与绑定流程', src: qrWizardProof },
        { alt: '运行状态与运维界面', caption: 'status / workers / retry 这类运维界面', src: opsPanelProof },
      ],
    },
    capabilities: {
      heading: '为什么它是工程工作台，而不是普通 bot',
      body: '中段要明确展示 backend 选择、workspace 路由、session 边界和运维恢复能力，让人知道它是日常工程入口。',
      items: [
        {
          title: '多后端切换',
          body: '同一个 bridge 进程可以按 chat / topic 切换 Claude Code、Cursor Agent、Codex 和兼容 wrapper。',
          chips: ['Claude Code', 'Cursor Agent', 'Codex'],
        },
        {
          title: '工作区和 session 路由',
          body: '每个 chat 保留独立 session，并通过 /ws 与 /new worktree 保持 repo 上下文清晰。',
          chips: ['/ws', '/new worktree', 'per-chat session'],
        },
        {
          title: '运行恢复与诊断',
          body: '失败后可以 /retry，卡住时可以 /status、/workers、/doctor，用户能看到真实运行状态。',
          chips: ['/retry', '/status', '/workers', '/doctor'],
        },
      ],
    },
    architecture: {
      heading: '桥是怎么工作的',
      body: '消息从 Lark 进入本地 bridge，再转到选中的 agent backend，并把输出流式刷新回卡片。',
      nodes: ['Lark / Feishu', '本地 lark-agent-bridge', 'Claude / Cursor / Codex', '本地仓库与命令'],
    },
    quickstart: {
      heading: '快速开始与运维入口',
      body: '把启动命令、首启说明、常用斜杠命令和文档入口放在一起，站点内优先提供中文设计与实现文档。',
      command: 'npx -y lark-agent-bridge@latest start',
      setupSteps: [
        '首次启动会出现扫码向导，用飞书 / Lark 绑定 PersonalAgent。',
        '确认权限 scope 与事件订阅后，再次启动即可开始在聊天里 @bot。',
        '使用 /cd、/ws、/new worktree 把 bridge 绑定到你的本地 repo。',
      ],
      commands: ['/ws', '/new worktree', '/retry', '/status', '/workers', '/doctor'],
      docs: [
        { label: '站点文档', href: '#docs' },
        { label: '中文 README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.zh.md' },
        { label: '中文介绍', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/docs/lark-agent-bridge-intro.zh.md' },
        { label: 'English README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.md' },
      ],
    },
    footer: {
      links: [
        { label: 'GitHub', href: 'https://github.com/fangpin/lark-agent-bridge' },
        { label: '站点文档', href: '#docs' },
        { label: '中文 README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.zh.md' },
        { label: 'English README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.md' },
      ],
      note: 'bridge 运行在本机，依赖你本地已安装并登录的 agent backend。',
    },
  },
  en: {
    nav: {
      docsHref: '#docs',
      docsLabel: 'Design docs',
      githubHref: 'https://github.com/fangpin/lark-agent-bridge',
      githubLabel: 'GitHub',
    },
    hero: {
      eyebrow: 'Lark / Feishu x Local Coding Agents',
      title: 'Run local coding agents from Lark',
      body:
        'Drive Claude Code, Cursor Agent, Codex, and compatible wrappers from chat while keeping workspace routing, per-chat sessions, retry, and status visible.',
      quickstartLabel: 'Quickstart',
      quickstartCommand: 'npx -y lark-agent-bridge@latest start',
      primaryCtaLabel: 'View on GitHub',
      primaryCtaHref: 'https://github.com/fangpin/lark-agent-bridge',
      secondaryCtaLabel: 'Read design docs',
      secondaryCtaHref: '#docs',
      backendBadges: ['Claude Code', 'Cursor Agent', 'Codex', 'Wrappers'],
      workspaceNotes: [
        'Each chat keeps its own session',
        'Workspace routing and /new worktree',
        'Operational recovery with /retry /workers /doctor',
      ],
    },
    proof: {
      heading: 'Real product proof',
      body: 'Put the actual product right under the hero: a streaming card, the QR/start flow, and an operational runtime view.',
      items: [
        { alt: 'Bridge message stream view', caption: 'Streaming card inside Lark / Feishu', src: larkCardProof },
        { alt: 'Terminal QR wizard view', caption: 'First-run terminal QR and bind flow', src: qrWizardProof },
        { alt: 'Runtime operations view', caption: 'Operational proof for status / workers / retry', src: opsPanelProof },
      ],
    },
    capabilities: {
      heading: 'Why this is an engineering workbench, not just a bot',
      body: 'Use the mid-page grid to explain backend choice, workspace routing, session boundaries, retry, and diagnostics.',
      items: [
        {
          title: 'Multi-backend switching',
          body: 'One bridge process can target Claude Code, Cursor Agent, Codex, and compatible wrappers per chat or topic.',
          chips: ['Claude Code', 'Cursor Agent', 'Codex'],
        },
        {
          title: 'Workspace and session routing',
          body: 'Each chat keeps its own session while /ws and /new worktree keep repo context explicit.',
          chips: ['/ws', '/new worktree', 'per-chat session'],
        },
        {
          title: 'Recovery and diagnostics',
          body: 'Failed runs keep /retry, while /status, /workers, and /doctor expose operational state instead of hiding it.',
          chips: ['/retry', '/status', '/workers', '/doctor'],
        },
      ],
    },
    architecture: {
      heading: 'How the bridge works',
      body: 'Messages enter from Lark, pass through the local bridge, run in the selected agent backend, and stream back into cards.',
      nodes: ['Lark / Feishu', 'local lark-agent-bridge', 'Claude / Cursor / Codex', 'local repo and commands'],
    },
    quickstart: {
      heading: 'Quickstart and operator entry points',
      body: 'Keep the install command, first-run notes, slash commands, and doc links together while exposing the mirrored site docs next to the READMEs.',
      command: 'npx -y lark-agent-bridge@latest start',
      setupSteps: [
        'The first launch opens a QR wizard so you can bind a PersonalAgent in Lark / Feishu.',
        'Confirm scopes and event subscriptions, then start the bridge again to begin chatting.',
        'Use /cd, /ws, and /new worktree to bind the bridge to the right local repo.',
      ],
      commands: ['/ws', '/new worktree', '/retry', '/status', '/workers', '/doctor'],
      docs: [
        { label: 'Site docs', href: '#docs' },
        { label: 'Chinese README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.zh.md' },
        { label: 'Chinese intro', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/docs/lark-agent-bridge-intro.zh.md' },
        { label: 'English README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.md' },
      ],
    },
    footer: {
      links: [
        { label: 'GitHub', href: 'https://github.com/fangpin/lark-agent-bridge' },
        { label: 'Site docs', href: '#docs' },
        { label: 'Chinese README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.zh.md' },
        { label: 'English README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.md' },
      ],
      note: 'The bridge runs locally and depends on locally installed, logged-in agent backends.',
    },
  },
};
