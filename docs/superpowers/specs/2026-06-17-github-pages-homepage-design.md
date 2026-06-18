# GitHub Pages Homepage Design

## Goal

Add a GitHub Pages homepage for `lark-agent-bridge` that makes the project feel like a live local-agent command center instead of a generic marketing page.

The site should:

- explain the core model quickly: bridge Lark/Feishu chat to local coding agents and local repos;
- emphasize that the product is an engineering workbench with backend switching, workspace routing, and per-chat sessions;
- use real product evidence close to the first screen so the page feels credible, not conceptual;
- default to Chinese copy, with English available as a parallel view;
- stay isolated from the CLI/runtime code so publishing the site does not affect bridge behavior.

## Scope

This design covers:

- a new static homepage under a dedicated `site/` subtree;
- bilingual content resources with Chinese as the default language;
- GitHub Pages deployment;
- homepage copy, visuals, sections, interaction rules, and acceptance criteria;
- small repository documentation updates needed to connect the site back to the repo.

This design does not cover:

- changes to bridge runtime behavior under `src/`;
- new agent, card, session, or workspace features;
- analytics, comment systems, blog/news feeds, or CMS integration;
- a separate documentation site beyond the homepage and linked existing docs.

## Amendment: docs surface for implementation detail

The first homepage pass established the public landing page, but this repo still qualifies as a docs-heavy project under the GitHub Pages homepage skill:

- `src/bot` is a meaningful orchestration layer
- `src/agent` contains several backend/runtime implementations
- `src/card` owns a real state machine plus multiple render paths
- session/workspace/worktree logic is not incidental
- runtime config/diagnostics are a separate operational layer

So the site should not stop at a single homepage plus external README links. The site must grow a first-class docs surface that:

- keeps long-form technical content in Markdown under `docs/`
- mirrors chapter depth across Chinese and English
- routes docs inside the existing `site/` owner instead of introducing a second app
- uses GitHub Pages-safe routing

Recommended chapter set:

1. overview / system map
2. message intake and run orchestration
3. agent abstraction and multi-backend adapters
4. card state machine and rendering
5. session / workspace / worktree binding
6. config / secrets / diagnostics / host runtime
7. homepage implementation itself

Implementation shape for docs:

- keep homepage and docs in the same Vite app under `site/`
- keep docs content in `docs/site/<locale>/*.md`
- use a lightweight in-app route surface that is safe on GitHub Pages project pages
- prefer hash-based docs routing over history routing

This amendment is additive: the demo-first homepage remains the front door, while the docs surface becomes the implementation-detail companion.

## Technical shape

Build the site as a self-contained static frontend in `site/` using `Vite + React`.

Constraints:

- Keep all site dependencies under `site/package.json`; do not mix homepage dependencies into the root CLI package.
- Treat the homepage as a separate build target from the Node CLI package.
- Use static content and local assets only. The site should not depend on runtime APIs, server-side rendering, or a backend.

Recommended layout:

- `site/src/main.tsx`: app bootstrap.
- `site/src/App.tsx`: homepage composition.
- `site/src/content/`: bilingual content objects.
- `site/src/components/`: hero, proof strip, capability grid, architecture band, quickstart band, footer.
- `site/src/assets/` or `site/public/`: screenshots, GIFs, logos, and any static decorative assets.

GitHub Pages deployment:

- Add a dedicated Pages workflow under `.github/workflows/`.
- Build the site from `site/`.
- Publish the built static output to GitHub Pages on pushes to `main` and manual dispatch.
- Configure the Vite `base` path for a project Pages site so assets resolve correctly under `/<repo-name>/`.

## Product framing

The site should present `lark-agent-bridge` as:

- a local bridge, not a hosted assistant;
- a chat entrypoint into real local engineering workflows;
- a multi-backend control surface for Claude Code, Cursor Agent, Codex, and compatible wrappers;
- a workspace-aware tool that keeps per-chat context instead of flattening everything into one bot thread.

The hero should lead with the engineering-workbench framing first, not with a generic "talk to your AI in chat" message.

## Content architecture

The homepage should be one page with clear vertical bands. The reading order matters.

### 1. Top navigation

Include:

- project name;
- GitHub link;
- language toggle shown as `中文 | EN`, with `中文` selected by default;
- one compact CTA to jump to quickstart or docs.

The nav should stay light. It exists to orient and route, not to become a product header with many links.

### 2. Command Center Hero

This is the first viewport and the identity anchor of the site.

Layout:

- a large headline and short explainer on the left/upper-left;
- a stylized live workspace panel occupying most of the hero;
- a compact right rail or stacked support panel with quickstart, backend badges, and workspace/session cues.

The first-screen message should answer:

- what the project is;
- why it is different from a normal chat bot;
- how quickly someone can try it.

Hero content priorities:

1. multi-backend + multi-workspace engineering-workbench framing;
2. visible run/session/workspace/backend state in the stylized panel;
3. a short installation/start command close to the hero, not buried far below.

The stylized panel should look like a live product cockpit:

- a Lark thread or mention prompt;
- a streaming card/state area;
- backend/session/workspace status chips;
- recovery/status affordance hints such as retry or worker visibility.

This panel can be partially stylized, but it must still feel derived from real product behavior.

### 3. Proof Strip

Immediately below the hero, add a proof band with real product evidence.

Required evidence types:

- a real Lark card capture;
- a real terminal or QR-wizard capture;
- optionally a short GIF or recorded sequence showing the bridge flow.

Purpose:

- prove that the product already exists;
- ground the hero after the more stylized opening;
- show the product working in its real environment without forcing the user into README-level detail immediately.

### 4. Capability Grid

Add a mid-page grid that explains why the bridge is operationally useful.

The grid should cover at least these themes:

- multi-backend switching;
- per-chat sessions and workspace routing;
- operational recovery (`/retry`, `/status`, `/workers`, `/doctor`);
- optional media/file access or worktree-oriented collaboration if space allows.

Each capability tile should pair a short user-centered benefit with a small UI fragment or command snippet. Avoid verbose paragraphs.

### 5. How It Works

Add a clean architecture band that explains the bridge flow:

- Lark/Feishu chat input;
- local `lark-agent-bridge` process;
- selected backend (`claude`, `agent`, `codex`, wrapper);
- local repo/tools/filesystem;
- streamed result returning to Lark cards.

This band should be diagrammatic and fast to scan. It should explain the mechanism without feeling like internal design documentation.

### 6. Quickstart and Setup

Add an explicit setup band with:

- install/start command;
- first-run scan/bind explanation;
- pointer to permission/event subscription setup;
- links to Chinese-first docs, plus English equivalents.

Chinese-first doc routing:

- primary docs CTA should point to `README.zh.md`;
- a secondary CTA can point to `docs/lark-agent-bridge-intro.zh.md`;
- English links should point to `README.md`.

### 7. Commands / Operational affordances

Expose a compact section for slash commands or operator affordances.

This should highlight commands such as:

- `/ws`;
- `/new worktree`;
- `/retry`;
- `/status`;
- `/workers`;
- `/doctor`.

The purpose is to show that the bridge is usable day-to-day, not just installable.

### 8. Footer

Include:

- GitHub link;
- npm/install reference;
- Chinese and English doc links;
- a short note that the bridge runs locally and depends on locally installed agent backends.

## Visual direction

The visual direction is `Demo-first Command Center`.

Rules:

- Do not build a generic startup landing page.
- Do not rely on a single blue-purple gradient theme.
- Keep the hero dark and operational, but let the proof and setup sections open into lighter surfaces so the page does not become visually monotonous.
- Use restrained motion that suggests a live stream: scanning, subtle pulse, status shimmer, staggered reveals.
- Keep proof assets calmer than the hero. Real screenshots should read as evidence, not as decorative wallpaper.

Recommended palette direction:

- deep graphite / near-black for the hero;
- cold cyan or mint accents for live status;
- warm sand / off-white or light stone in proof/setup sections to break the palette and avoid the page reading as pure sci-fi chrome.

Typography should feel engineered and editorial, not default SaaS.

## Language and content model

Chinese is the default language.

Implementation rules:

- load Chinese content first on initial render;
- keep the English version available through the nav toggle;
- use one shared layout with two content resources rather than two different page implementations;
- keep section order identical across languages so maintenance stays aligned.

Content source priorities:

1. `README.zh.md` for primary Chinese product wording and setup references;
2. `docs/lark-agent-bridge-intro.zh.md` for richer Chinese narrative;
3. `README.md` for the English variant.

Avoid inventing claims not supported by the current docs or current product behavior.

## Assets and evidence requirements

Implementation should gather real visual proof before considering the homepage complete.

Minimum required real assets:

- one Lark streaming card screenshot;
- one terminal or QR-wizard screenshot;
- one additional real bridge-oriented capture, such as slash commands, workers, status, or run history.

Optional:

- one short GIF/video loop showing the bridge in action.

If a first implementation pass must ship before all captures are available, placeholder frames are acceptable only temporarily. Final completion requires real captures in the proof band.

## Repository and docs integration

The homepage should be discoverable from the repository.

Implementation should update `README.md` and `README.zh.md` to add a homepage link or short pointer once the site URL exists.

Do not rewrite existing README structure beyond the minimum needed to connect the repo and the homepage.

## Verification and acceptance criteria

The homepage is complete when all of the following are true:

- the site builds successfully from `site/`;
- GitHub Pages deployment is configured and produces a working static site;
- Chinese is the default language and English can be switched on the page;
- the first viewport clearly communicates the multi-backend, multi-workspace workbench positioning;
- a quickstart command appears at or near the hero;
- real product evidence appears close to the hero, not only deep in the page;
- desktop and mobile layouts keep text readable and non-overlapping;
- the page includes links back to GitHub and existing docs;
- no bridge runtime code under `src/` is modified to support the homepage.

Implementation-time verification should include:

- local site dev/build verification;
- browser checks on desktop and mobile widths;
- confirmation that the GitHub Pages base path works for assets and internal navigation;
- a quick sanity read in both Chinese and English modes for copy overflow and layout integrity.

## Non-goals

- No new product feature work packaged as "homepage support".
- No redesign of the main README into a full docs portal.
- No backend service for the homepage.
- No separate Chinese and English code paths with divergent layouts.
- No requirement to embed live bridge telemetry in the homepage.
