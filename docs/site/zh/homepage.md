# GitHub Pages 主页实现

这一章解释当前项目主页是怎么落地的，以及为什么这次实现从“酷炫首页”扩成了“首页 + 详细设计实现文档”的站点结构。

## 目标变化：从展示页升级成项目文档入口

最初的主页已经完成了几件事：

- 独立 `site/` 子树
- Vite + React
- GitHub Pages base path
- 中文默认、英文切换
- 首页 hero / proof / capability / quickstart

但它还不满足 `github-pages-project-homepage` skill 对 docs-heavy repo 的要求：仓库有多个清晰实现层，却只有首页和 README 跳转，没有站点内的详细实现章节。

所以这次补齐的不是“再换个 hero”，而是：

1. 站点内 Markdown 文档面
2. 中英对称章节
3. 首页到 docs 的一等入口
4. 对 GitHub Pages 友好的路由方案

## 为什么继续沿用 `site/`

当前仓库 root 主要是 Node CLI/runtime 代码，站点已经在 `site/` 里独立运行。继续沿用这个 owner 有几个好处：

- 不把前端依赖混进根目录 CLI 包
- `site` 可以独立 `npm test` / `npm run build`
- Pages workflow 也已经指向 `site`

这符合 skill 的“已有 canonical site owner 就扩展它，不要再造第二个 app”。

## 文档内容为什么改成 Markdown

详细实现文档如果继续写在 `App.tsx` 或 `copy.ts` 里，会立刻出现两个问题：

1. 文档增长必须改 JSX 结构
2. 章节越多，维护成本越像手写 CMS

因此当前实现把长文档挪到：

- `docs/site/zh/*.md`
- `docs/site/en/*.md`

再由站点读取 raw Markdown 渲染。这样：

- 文档 owner 还是 `docs/`
- 站点只负责导航和显示
- 后续加章不需要继续挤进首页组件

## 路由方案：hash route，而不是 history route

当前站点没有引入 React Router，而是用 `window.location.hash` 在 `site/src/App.tsx` 里手写了轻量路由。

路由形态：

- `#home`
- `#docs`
- `#docs/overview`
- `#docs/orchestration`

这么做的原因不是“偷懒”，而是 GitHub Pages project site 的实际约束：

- 站点部署在 `/lark-agent-bridge/`
- 如果用 history route，直接刷新深链接容易落到 Pages 404
- hash route 在 Pages 下最稳，不需要额外的 SPA fallback 配置

## 现在的站点结构

核心文件：

- `site/src/App.tsx`
- `site/src/content/copy.ts`
- `site/src/content/docs.ts`
- `site/src/components/DocsLayout.tsx`
- `site/src/components/MarkdownArticle.tsx`
- `site/src/styles.css`

职责拆分：

- `App.tsx` 负责 locale 和 hash route
- `copy.ts` 负责首页双语结构化文案
- `docs.ts` 负责中英章节目录与 raw Markdown 装配
- `DocsLayout.tsx` 负责 docs 导航、当前章节、overview 卡片地图
- `MarkdownArticle.tsx` 负责 Markdown 渲染和外链行为

## Vite 配置与 Pages base

`site/vite.config.ts` 仍然保持：

```ts
base: '/lark-agent-bridge/'
```

这一步不能省，因为当前仓库是 project pages，不是 user pages。站点部署后的真实地址是：

`https://fangpin.github.io/lark-agent-bridge/`

如果 `base` 写成 `/`，本地预览可能还正常，但 Pages 上的资源路径会直接错掉。

## workflow 保持独立站点构建

`.github/workflows/pages.yml` 当前的构建流程是：

1. checkout
2. setup-node
3. install `site/` 依赖
4. build `site/`
5. upload `site/dist`
6. deploy-pages

这继续满足“主页是单独 build target，不影响 root CLI runtime”的原则。

## 文档章节怎么分

这次没有按 marketing 分类拆文档，而是按仓库实现边界拆成：

- overview
- orchestration
- agents
- cards
- sessions
- runtime
- homepage

其中 `overview` 作为系统地图；其余章节一章对应一个主要 ownership boundary。这个拆法直接符合 skill 里“多个实现层就拆多章，而不是一篇更长 overview”。

## 本地验证方式

这一轮实现的验证重点是 `site/` 自身，而不是 root runtime：

```bash
npm --prefix site install
npm --prefix site test
npm --prefix site run build
```

同时需要确认：

- `#docs` 能正常进入 docs 视图
- `#docs/<slug>` 能打开代表章节
- 语言切换会同步切换文档内容
- GitHub 链接和站点文档入口可见

## 这次补齐后，站点的角色

当前 Pages 站点不再只是一个展示页，它现在同时承担两件事：

1. 首页：给项目一个快速、可信、带证据的公共入口
2. Docs：给读源码的人一个按实现边界组织的系统地图

这也是这次改动最重要的变化。
