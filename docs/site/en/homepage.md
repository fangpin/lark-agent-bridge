# GitHub Pages Homepage Implementation

This chapter explains how the current project site is built, and why the homepage work expanded into a real docs surface instead of staying as a single landing page.

## From showcase page to project docs entrypoint

The earlier homepage already established:

- an isolated `site/` app
- Vite + React
- the correct GitHub Pages base path
- Chinese default with English toggle
- a demo-first homepage structure

What it did not yet satisfy was the docs-heavy requirement from the `github-pages-project-homepage` skill. This repo has several clear implementation layers, but the site still stopped at the homepage plus links out to READMEs.

This pass fills that gap with:

1. a first-class docs surface inside the site
2. mirrored chapter sets in Chinese and English
3. a homepage-to-docs navigation path
4. a routing shape that stays friendly to GitHub Pages project sites

## Why the work stayed inside `site/`

The root repo is primarily a Node CLI/runtime codebase. The existing site already owned public web delivery, so extending that owner was the conservative choice:

- no frontend dependency bleed into the CLI package
- isolated `site` test/build commands
- no second competing docs app

## Why the docs are Markdown-backed

Long-form implementation docs do not age well when embedded directly in JSX or JSON copy blobs. The current docs move long content into:

- `docs/site/zh/*.md`
- `docs/site/en/*.md`

The site then imports those files as raw Markdown and renders them. That keeps:

- content ownership in `docs/`
- presentation ownership in `site/`
- future doc expansion out of the homepage component tree

## Routing choice: hash route, not history route

The docs surface uses lightweight hash-based routing in `site/src/App.tsx`:

- `#home`
- `#docs`
- `#docs/overview`
- `#docs/orchestration`

That choice is deliberate. The deployed site lives under:

`https://fangpin.github.io/lark-agent-bridge/`

On GitHub Pages project sites, deep history routes are easy to break on refresh unless extra SPA fallback handling is added. Hash routes avoid that problem cleanly.

## Site structure after the docs expansion

Key files:

- `site/src/App.tsx`
- `site/src/content/copy.ts`
- `site/src/content/docs.ts`
- `site/src/components/DocsLayout.tsx`
- `site/src/components/MarkdownArticle.tsx`
- `site/src/styles.css`

Responsibilities:

- `App.tsx` owns locale state and hash routing
- `copy.ts` owns bilingual homepage copy
- `docs.ts` owns chapter metadata and raw Markdown wiring
- `DocsLayout.tsx` owns docs navigation and chapter rendering layout
- `MarkdownArticle.tsx` owns Markdown rendering behavior

## Vite base path

`site/vite.config.ts` keeps:

```ts
base: '/lark-agent-bridge/'
```

That is required because this repo is a project page, not a user page. Local preview may still work with `/`, but deployed assets would break on GitHub Pages.

## Pages workflow

`.github/workflows/pages.yml` continues to:

1. install dependencies under `site/`
2. build the site under `site/`
3. upload `site/dist`
4. deploy through GitHub Pages

This preserves the separation between the homepage build target and the root CLI/runtime package.

## Chapter split

The docs surface is split by implementation boundary, not by marketing category:

- overview
- orchestration
- agents
- cards
- sessions
- runtime
- homepage

The overview acts as the system map. The remaining chapters map to real ownership boundaries in the codebase.

## Local verification

Verification for this work should stay focused on `site/`:

```bash
npm --prefix site install
npm --prefix site test
npm --prefix site run build
```

And the site should be checked for:

- `#docs` route health
- representative chapter routes such as `#docs/orchestration`
- locale switching across docs content
- visible GitHub and docs navigation

## The role of the site now

The project site now does two jobs:

1. homepage: fast project signal, proof, quickstart, repo identity
2. docs: implementation-oriented chapters grounded in the actual codebase

That is the main difference between the earlier homepage pass and the current site.
