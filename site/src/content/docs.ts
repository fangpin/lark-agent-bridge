import type { Locale } from './copy';
import overviewZh from '../../../docs/site/zh/overview.md?raw';
import orchestrationZh from '../../../docs/site/zh/orchestration.md?raw';
import agentsZh from '../../../docs/site/zh/agents.md?raw';
import cardsZh from '../../../docs/site/zh/cards.md?raw';
import sessionsZh from '../../../docs/site/zh/sessions.md?raw';
import runtimeZh from '../../../docs/site/zh/runtime.md?raw';
import homepageZh from '../../../docs/site/zh/homepage.md?raw';
import overviewEn from '../../../docs/site/en/overview.md?raw';
import orchestrationEn from '../../../docs/site/en/orchestration.md?raw';
import agentsEn from '../../../docs/site/en/agents.md?raw';
import cardsEn from '../../../docs/site/en/cards.md?raw';
import sessionsEn from '../../../docs/site/en/sessions.md?raw';
import runtimeEn from '../../../docs/site/en/runtime.md?raw';
import homepageEn from '../../../docs/site/en/homepage.md?raw';

export interface DocChapter {
  slug: string;
  title: string;
  summary: string;
  sourcePath: string;
  markdown: string;
}

export interface DocsContent {
  eyebrow: string;
  title: string;
  body: string;
  chapterListLabel: string;
  sourceLabel: string;
  homeLabel: string;
  homeHref: string;
  githubLabel: string;
  githubHref: string;
  chapterMapHeading: string;
  chapterMapBody: string;
  chapters: DocChapter[];
}

function chapter(
  slug: string,
  title: string,
  summary: string,
  sourcePath: string,
  markdown: string,
): DocChapter {
  return { slug, title, summary, sourcePath, markdown };
}

export const docsContent: Record<Locale, DocsContent> = {
  zh: {
    eyebrow: 'Docs',
    title: '设计与实现文档',
    body:
      '这一组章节直接对照仓库里的源码边界来解释 lark-agent-bridge，包括消息编排、backend 适配、卡片状态机、session/workspace 持久化，以及 GitHub Pages 站点本身的实现。',
    chapterListLabel: '章节导航',
    sourceLabel: 'Markdown 源文件',
    homeLabel: '返回首页',
    homeHref: '#home',
    githubLabel: 'GitHub 仓库',
    githubHref: 'https://github.com/fangpin/lark-agent-bridge',
    chapterMapHeading: '章节地图',
    chapterMapBody: 'Overview 负责系统地图，其余章节按运行时职责拆开，每章都落到真实文件边界与当前实现限制。',
    chapters: [
      chapter(
        'overview',
        '系统总览与代码边界',
        '从启动入口、bot 编排、agent backend、卡片渲染、session/workspace 到诊断与站点交付，先把仓库里真正承担职责的模块边界拉平。',
        'docs/site/zh/overview.md',
        overviewZh,
      ),
      chapter(
        'orchestration',
        '消息接入与运行编排',
        '解释 `startChannel()` 如何把 Lark 消息变成单 scope 串行、可恢复、可中断的 agent run，包括持久队列、pending queue、active runs 和 run history。',
        'docs/site/zh/orchestration.md',
        orchestrationZh,
      ),
      chapter(
        'agents',
        'Agent 抽象与多后端适配',
        '覆盖 `AgentAdapter` 协议、registry/factory、Claude CLI、Cursor SDK/CLI 双路径，以及 Codex JSON 适配层的实现差异。',
        'docs/site/zh/agents.md',
        agentsZh,
      ),
      chapter(
        'cards',
        '卡片状态机与渲染路径',
        '从 `RunState` 归约、todo 看板、工具折叠，到 card/markdown/text 三种输出和 CardKit 回调分发，解释用户最终看到的界面是怎么生成的。',
        'docs/site/zh/cards.md',
        cardsZh,
      ),
      chapter(
        'sessions',
        'Session、Workspace 与 Worktree 绑定',
        '说明 sessionKey 级隔离、portable path 归一化、named workspace、backend scope 绑定，以及 worktree 的创建与安全清理规则。',
        'docs/site/zh/sessions.md',
        sessionsZh,
      ),
      chapter(
        'runtime',
        '配置、密钥、诊断与宿主运行时',
        '梳理 config schema、secret resolver、start 生命周期、setup diagnostics、结构化日志、process registry 和 media cache。',
        'docs/site/zh/runtime.md',
        runtimeZh,
      ),
      chapter(
        'homepage',
        'GitHub Pages 主页实现',
        '把这次项目主页的目标、信息架构、Markdown 文档面、hash 路由、Vite base、Pages workflow 和本地验证方式写成可维护的实现文档。',
        'docs/site/zh/homepage.md',
        homepageZh,
      ),
    ],
  },
  en: {
    eyebrow: 'Docs',
    title: 'Design and Implementation Docs',
    body:
      'These chapters follow the actual code boundaries in the repository: message orchestration, backend adapters, card state/rendering, session and workspace persistence, host diagnostics, and the GitHub Pages site itself.',
    chapterListLabel: 'Chapters',
    sourceLabel: 'Markdown source',
    homeLabel: 'Back to homepage',
    homeHref: '#home',
    githubLabel: 'GitHub repo',
    githubHref: 'https://github.com/fangpin/lark-agent-bridge',
    chapterMapHeading: 'Chapter map',
    chapterMapBody:
      'The overview acts as a system map. The remaining chapters follow runtime ownership boundaries and call out the current implementation limits instead of idealized architecture.',
    chapters: [
      chapter(
        'overview',
        'System Map and Code Boundaries',
        'Flatten the repo into the real ownership boundaries: process start, bot orchestration, backend adapters, card rendering, session/workspace persistence, diagnostics, and site delivery.',
        'docs/site/en/overview.md',
        overviewEn,
      ),
      chapter(
        'orchestration',
        'Message Intake and Run Orchestration',
        'Show how `startChannel()` turns Lark messages into one active run per scope, backed by durable queue state, pending batching, interrupts, and run history.',
        'docs/site/en/orchestration.md',
        orchestrationEn,
      ),
      chapter(
        'agents',
        'Agent Abstraction and Multi-backend Adapters',
        'Cover the `AgentAdapter` contract, registry/factory, Claude CLI, Cursor SDK/CLI dual runtime, and the Codex JSON adapter with their resume and pooling differences.',
        'docs/site/en/agents.md',
        agentsEn,
      ),
      chapter(
        'cards',
        'Card State Machine and Rendering Paths',
        'Explain how `RunState`, todo-board rendering, tool collapsing, and card/markdown/text outputs work together, including CardKit callback dispatch.',
        'docs/site/en/cards.md',
        cardsEn,
      ),
      chapter(
        'sessions',
        'Session, Workspace, and Worktree Binding',
        'Describe session isolation by sessionKey, portable path normalization, named workspaces, backend scope binding, and the worktree create/clear safety rules.',
        'docs/site/en/sessions.md',
        sessionsEn,
      ),
      chapter(
        'runtime',
        'Config, Secrets, Diagnostics, and Host Runtime',
        'Walk through config schema, secret resolution, start lifecycle, setup diagnostics, structured logging, process registry, and media cache behavior.',
        'docs/site/en/runtime.md',
        runtimeEn,
      ),
      chapter(
        'homepage',
        'GitHub Pages Homepage Implementation',
        'Document the project-site goals, information architecture, Markdown docs surface, hash routing, Vite base path, Pages workflow, and local verification flow.',
        'docs/site/en/homepage.md',
        homepageEn,
      ),
    ],
  },
};
