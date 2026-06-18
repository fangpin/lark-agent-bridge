# GitHub Pages Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a bilingual GitHub Pages homepage for `lark-agent-bridge` with a demo-first command-center hero, real product proof, and Chinese as the default language.

**Architecture:** Add a self-contained `site/` Vite + React app with its own dependencies, tests, and static assets. Keep homepage implementation isolated from the CLI/runtime code under `src/`, and deploy the built `site/dist` output through a dedicated GitHub Pages workflow.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Testing Library, GitHub Pages Actions, existing README/docs content.

---

## Amendment: docs implementation follow-up

The original homepage plan shipped the public landing page, but the repo still needed the detailed technical docs required by the GitHub Pages homepage skill for docs-heavy repositories.

Follow-up implementation scope:

- add Markdown-backed docs chapters under `docs/site/zh/` and `docs/site/en/`
- add a docs route surface inside the existing `site/` app
- keep the docs bilingual and chapter-symmetric
- keep the routing GitHub Pages-safe
- expose the docs from the homepage nav, quickstart section, footer, and README files

Follow-up files:

- `docs/site/zh/*.md`
- `docs/site/en/*.md`
- `site/src/content/docs.ts`
- `site/src/components/DocsLayout.tsx`
- `site/src/components/MarkdownArticle.tsx`
- `site/src/App.tsx`
- `site/src/App.test.tsx`
- `site/src/styles.css`
- `README.md`
- `README.zh.md`

Verification for the follow-up remains site-local:

- `npm --prefix site test`
- `npm --prefix site run build`
- preview one representative docs route per locale

---

## File Structure

- `site/package.json` — homepage-specific scripts and dependencies.
- `site/tsconfig.json` — strict TypeScript settings for the static site.
- `site/vite.config.ts` — Vite config with React plugin, Vitest setup, and GitHub Pages base path.
- `site/index.html` — Vite entry HTML.
- `site/src/main.tsx` — React bootstrap.
- `site/src/App.tsx` — homepage composition and locale state.
- `site/src/styles.css` — all homepage layout, color, motion, and responsive styling.
- `site/src/test/setup.ts` — Testing Library matchers.
- `site/src/App.test.tsx` — homepage rendering, locale, proof, and docs-link regression tests.
- `site/src/content/copy.ts` — structured Chinese and English homepage copy.
- `site/src/components/LanguageToggle.tsx` — locale switch UI.
- `site/src/components/HeroSection.tsx` — command-center hero.
- `site/src/components/ProofStrip.tsx` — real product evidence band.
- `site/src/components/CapabilityGrid.tsx` — backend/workspace/recovery value grid.
- `site/src/components/ArchitectureBand.tsx` — bridge flow explanation band.
- `site/src/components/QuickstartSection.tsx` — setup, slash commands, and docs CTA band.
- `site/src/components/SiteFooter.tsx` — footer links and local-runtime note.
- `site/src/assets/proof/lark-card.png` — real Lark card screenshot.
- `site/src/assets/proof/qr-wizard.png` — real terminal/QR wizard screenshot.
- `site/src/assets/proof/ops-panel.png` — real operational/status screenshot.
- `.github/workflows/pages.yml` — GitHub Pages build and deploy workflow.
- `README.md` — homepage link in English docs.
- `README.zh.md` — homepage link in Chinese docs.

The root `.gitignore` already ignores nested `node_modules/` and `dist/`, so no ignore-file change is required for `site/`.

---

### Task 1: Scaffold the standalone site workspace and smoke-test shell

**Files:**
- Create: `site/package.json`
- Create: `site/tsconfig.json`
- Create: `site/vite.config.ts`
- Create: `site/index.html`
- Create: `site/src/main.tsx`
- Create: `site/src/App.tsx`
- Create: `site/src/styles.css`
- Create: `site/src/test/setup.ts`
- Create: `site/src/App.test.tsx`

- [ ] **Step 1: Create the site toolchain files and the first failing smoke test**

Create `site/package.json`:

```json
{
  "name": "lark-agent-bridge-site",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vitest": "^2.1.8"
  }
}
```

Create `site/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

Create `site/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/lark-agent-bridge/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
```

Create `site/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>lark-agent-bridge</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `site/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

Create `site/src/App.tsx`:

```tsx
export default function App() {
  return <div />;
}
```

Create `site/src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Create `site/src/styles.css`:

```css
:root {
  color-scheme: dark;
  font-family: "Helvetica Neue", Arial, sans-serif;
  background: #050816;
  color: #f7f7fb;
}

body {
  margin: 0;
}
```

Create `site/src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import App from './App';

describe('homepage shell', () => {
  test('defaults to Chinese and switches to English', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.getByRole('heading', { name: '把本地 coding agents 接进飞书工作台' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'EN' }));

    expect(
      screen.getByRole('heading', { name: 'Run local coding agents from Lark' }),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Install the site dependencies**

Run: `npm --prefix site install`

Expected: npm exits `0` and creates `site/package-lock.json`.

- [ ] **Step 3: Run the smoke test to verify the shell fails for the right reason**

Run: `npm --prefix site test -- src/App.test.tsx`

Expected: FAIL with a Testing Library error that the Chinese hero heading is missing.

- [ ] **Step 4: Implement the minimal locale shell to make the smoke test pass**

Replace `site/src/App.tsx` with:

```tsx
import { useState } from 'react';

type Locale = 'zh' | 'en';

const titles: Record<Locale, string> = {
  zh: '把本地 coding agents 接进飞书工作台',
  en: 'Run local coding agents from Lark',
};

export default function App() {
  const [locale, setLocale] = useState<Locale>('zh');

  return (
    <main className="site-shell">
      <header className="site-nav">
        <span className="brand">lark-agent-bridge</span>
        <div className="locale-toggle" role="group" aria-label="Language toggle">
          <button type="button" aria-pressed={locale === 'zh'} onClick={() => setLocale('zh')}>
            中文
          </button>
          <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>
            EN
          </button>
        </div>
      </header>
      <section className="hero-shell">
        <h1>{titles[locale]}</h1>
      </section>
    </main>
  );
}
```

Replace `site/src/styles.css` with:

```css
:root {
  color-scheme: dark;
  font-family: "Helvetica Neue", Arial, sans-serif;
  background: #050816;
  color: #f7f7fb;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at top left, rgba(77, 208, 225, 0.2), transparent 28%),
    linear-gradient(180deg, #08101d 0%, #050816 100%);
}

.site-shell {
  min-height: 100vh;
  padding: 24px;
}

.site-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.brand {
  font-size: 14px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #91d7ff;
}

.locale-toggle {
  display: inline-flex;
  gap: 8px;
}

.locale-toggle button {
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: transparent;
  color: inherit;
  padding: 8px 12px;
  cursor: pointer;
}

.hero-shell {
  display: flex;
  align-items: center;
  min-height: calc(100vh - 88px);
}

.hero-shell h1 {
  margin: 0;
  max-width: 12ch;
  font-size: clamp(48px, 8vw, 88px);
  line-height: 0.96;
}
```

- [ ] **Step 5: Re-run the smoke test and the first build**

Run: `npm --prefix site test -- src/App.test.tsx && npm --prefix site run build`

Expected: the test passes and Vite writes `site/dist/index.html`.

- [ ] **Step 6: Commit the scaffold**

```bash
git add site/package.json site/package-lock.json site/tsconfig.json site/vite.config.ts site/index.html site/src/main.tsx site/src/App.tsx site/src/styles.css site/src/test/setup.ts site/src/App.test.tsx
git commit -m "feat: scaffold GitHub Pages homepage"
```

---

### Task 2: Add structured bilingual copy, navigation, and the command-center hero

**Files:**
- Create: `site/src/content/copy.ts`
- Create: `site/src/components/LanguageToggle.tsx`
- Create: `site/src/components/HeroSection.tsx`
- Modify: `site/src/App.tsx`
- Modify: `site/src/styles.css`
- Modify: `site/src/App.test.tsx`

- [ ] **Step 1: Add a failing hero-content test**

Append this test to `site/src/App.test.tsx`:

```tsx
test('shows the default Chinese hero quickstart and backend chips', () => {
  render(<App />);

  expect(screen.getByText('npx -y lark-agent-bridge@latest start')).toBeInTheDocument();
  expect(screen.getByText('Claude Code')).toBeInTheDocument();
  expect(screen.getByText('Cursor Agent')).toBeInTheDocument();
  expect(screen.getByText('Codex')).toBeInTheDocument();
  expect(screen.getByText('每个 chat 保留独立 session')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the hero-content test to verify it fails**

Run: `npm --prefix site test -- src/App.test.tsx`

Expected: FAIL because the quickstart command and hero chips are not rendered yet.

- [ ] **Step 3: Add structured copy and dedicated hero components**

Create `site/src/content/copy.ts`:

```ts
export type Locale = 'zh' | 'en';

export interface HomeCopy {
  nav: {
    docsHref: string;
    docsLabel: string;
    githubHref: string;
    githubLabel: string;
  };
  hero: {
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
  };
}

export const copy: Record<Locale, HomeCopy> = {
  zh: {
    nav: {
      docsHref: '#quickstart',
      docsLabel: '查看接入文档',
      githubHref: 'https://github.com/fangpin/lark-agent-bridge',
      githubLabel: 'GitHub',
    },
    hero: {
      eyebrow: 'Lark / Feishu x Local Coding Agents',
      title: '把本地 coding agents 接进飞书工作台',
      body:
        '在聊天里驱动 Claude Code、Cursor Agent、Codex 和兼容 wrapper，并把 workspace、session、retry、status 这些工程上下文一并带进来。',
      quickstartLabel: '快速开始',
      quickstartCommand: 'npx -y lark-agent-bridge@latest start',
      primaryCtaLabel: '查看 GitHub',
      primaryCtaHref: 'https://github.com/fangpin/lark-agent-bridge',
      secondaryCtaLabel: '查看接入文档',
      secondaryCtaHref: '#quickstart',
      backendBadges: ['Claude Code', 'Cursor Agent', 'Codex', 'Wrappers'],
      workspaceNotes: [
        '每个 chat 保留独立 session',
        '支持 workspace 路由与 /new worktree',
        '失败后保留 /retry /workers /doctor',
      ],
    },
  },
  en: {
    nav: {
      docsHref: '#quickstart',
      docsLabel: 'Read setup',
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
      secondaryCtaLabel: 'Read setup',
      secondaryCtaHref: '#quickstart',
      backendBadges: ['Claude Code', 'Cursor Agent', 'Codex', 'Wrappers'],
      workspaceNotes: [
        'Each chat keeps its own session',
        'Workspace routing and /new worktree',
        'Operational recovery with /retry /workers /doctor',
      ],
    },
  },
};
```

Create `site/src/components/LanguageToggle.tsx`:

```tsx
import type { Locale } from '../content/copy';

interface LanguageToggleProps {
  locale: Locale;
  onChange: (locale: Locale) => void;
}

export function LanguageToggle({ locale, onChange }: LanguageToggleProps) {
  return (
    <div className="locale-toggle" role="group" aria-label="Language toggle">
      <button type="button" aria-pressed={locale === 'zh'} onClick={() => onChange('zh')}>
        中文
      </button>
      <button type="button" aria-pressed={locale === 'en'} onClick={() => onChange('en')}>
        EN
      </button>
    </div>
  );
}
```

Create `site/src/components/HeroSection.tsx`:

```tsx
import type { HomeCopy } from '../content/copy';

interface HeroSectionProps {
  copy: HomeCopy['hero'];
}

export function HeroSection({ copy }: HeroSectionProps) {
  return (
    <section className="hero-grid" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1 id="hero-title">{copy.title}</h1>
        <p className="hero-body">{copy.body}</p>
        <div className="hero-cta-row">
          <a className="primary-cta" href={copy.primaryCtaHref}>
            {copy.primaryCtaLabel}
          </a>
          <a className="secondary-cta" href={copy.secondaryCtaHref}>
            {copy.secondaryCtaLabel}
          </a>
        </div>
      </div>

      <div className="hero-cockpit" aria-label="Command center preview">
        <div className="cockpit-card">
          <div className="panel-label">{copy.quickstartLabel}</div>
          <code>{copy.quickstartCommand}</code>
        </div>
        <div className="cockpit-card">
          <div className="panel-label">Backends</div>
          <div className="badge-row">
            {copy.backendBadges.map((badge) => (
              <span key={badge} className="status-chip">
                {badge}
              </span>
            ))}
          </div>
        </div>
        <div className="cockpit-card">
          <div className="panel-label">Workspace / Session</div>
          <ul className="hero-note-list">
            {copy.workspaceNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
```

Replace `site/src/App.tsx` with:

```tsx
import { useState } from 'react';
import { HeroSection } from './components/HeroSection';
import { LanguageToggle } from './components/LanguageToggle';
import { copy, type Locale } from './content/copy';

export default function App() {
  const [locale, setLocale] = useState<Locale>('zh');
  const content = copy[locale];

  return (
    <main className="site-shell">
      <header className="site-nav">
        <span className="brand">lark-agent-bridge</span>
        <nav className="nav-links" aria-label="Primary">
          <a href={content.nav.githubHref}>{content.nav.githubLabel}</a>
          <a href={content.nav.docsHref}>{content.nav.docsLabel}</a>
        </nav>
        <LanguageToggle locale={locale} onChange={setLocale} />
      </header>
      <HeroSection copy={content.hero} />
    </main>
  );
}
```

Append these blocks to `site/src/styles.css`:

```css
.nav-links {
  display: flex;
  gap: 16px;
}

.nav-links a {
  color: #dbe7ff;
  text-decoration: none;
}

.hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
  gap: 24px;
  min-height: calc(100vh - 88px);
  align-items: center;
}

.hero-copy {
  display: grid;
  gap: 18px;
}

.eyebrow {
  margin: 0;
  color: #82e7ff;
  font-size: 13px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.hero-body {
  margin: 0;
  max-width: 62ch;
  color: #c3d0ea;
  font-size: 18px;
  line-height: 1.6;
}

.hero-cta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.primary-cta,
.secondary-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 16px;
  text-decoration: none;
}

.primary-cta {
  background: #edf4ff;
  color: #08101d;
}

.secondary-cta {
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #edf4ff;
}

.hero-cockpit {
  display: grid;
  gap: 16px;
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(9, 15, 31, 0.78);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.3);
}

.cockpit-card {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.panel-label {
  color: #86dfff;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.badge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.status-chip {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
}

.hero-note-list {
  margin: 0;
  padding-left: 18px;
  color: #dbe7ff;
  line-height: 1.5;
}
```

- [ ] **Step 4: Re-run the tests and build**

Run: `npm --prefix site test -- src/App.test.tsx && npm --prefix site run build`

Expected: both tests pass and the hero now includes the quickstart command plus backend/workspace chips.

- [ ] **Step 5: Commit the hero work**

```bash
git add site/src/content/copy.ts site/src/components/LanguageToggle.tsx site/src/components/HeroSection.tsx site/src/App.tsx site/src/styles.css site/src/App.test.tsx
git commit -m "feat: add homepage hero and locale toggle"
```

---

### Task 3: Add the proof strip and wire in real product captures

**Files:**
- Create: `site/src/components/ProofStrip.tsx`
- Create: `site/src/assets/proof/lark-card.png`
- Create: `site/src/assets/proof/qr-wizard.png`
- Create: `site/src/assets/proof/ops-panel.png`
- Modify: `site/src/content/copy.ts`
- Modify: `site/src/App.tsx`
- Modify: `site/src/styles.css`
- Modify: `site/src/App.test.tsx`

- [ ] **Step 1: Add a failing proof-strip test**

Append this test to `site/src/App.test.tsx`:

```tsx
test('shows real product proof directly below the hero', () => {
  render(<App />);

  expect(screen.getByRole('heading', { name: '真实运行证据' })).toBeInTheDocument();
  expect(screen.getByAltText('飞书流式卡片截图')).toBeInTheDocument();
  expect(screen.getByAltText('终端扫码向导截图')).toBeInTheDocument();
  expect(screen.getByAltText('运行状态截图')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the proof-strip test to verify it fails**

Run: `npm --prefix site test -- src/App.test.tsx`

Expected: FAIL because the proof heading and proof images do not exist yet.

- [ ] **Step 3: Capture the three real proof images into the site asset tree**

Run:

```bash
mkdir -p site/src/assets/proof
screencapture -i site/src/assets/proof/lark-card.png
screencapture -i site/src/assets/proof/qr-wizard.png
screencapture -i site/src/assets/proof/ops-panel.png
file site/src/assets/proof/lark-card.png site/src/assets/proof/qr-wizard.png site/src/assets/proof/ops-panel.png
```

Expected: `file` reports `PNG image data` for all three captures.

- [ ] **Step 4: Implement the proof-strip component and content**

Create `site/src/components/ProofStrip.tsx`:

```tsx
interface ProofItem {
  alt: string;
  caption: string;
  src: string;
}

interface ProofStripProps {
  heading: string;
  body: string;
  items: ProofItem[];
}

export function ProofStrip({ heading, body, items }: ProofStripProps) {
  return (
    <section className="proof-strip" aria-labelledby="proof-heading">
      <div className="section-copy">
        <p className="section-kicker">Proof</p>
        <h2 id="proof-heading">{heading}</h2>
        <p>{body}</p>
      </div>
      <div className="proof-grid">
        {items.map((item) => (
          <figure key={item.alt} className="proof-card">
            <img src={item.src} alt={item.alt} />
            <figcaption>{item.caption}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
```

At the top of `site/src/content/copy.ts`, add:

```ts
import larkCardProof from '../assets/proof/lark-card.png';
import opsPanelProof from '../assets/proof/ops-panel.png';
import qrWizardProof from '../assets/proof/qr-wizard.png';
```

In `HomeCopy`, add:

```ts
  proof: {
    heading: string;
    body: string;
    items: { alt: string; caption: string; src: string }[];
  };
```

In the Chinese copy object, add:

```ts
    proof: {
      heading: '真实运行证据',
      body: '首屏下面直接给出真实界面，而不是只放概念图：飞书卡片、扫码绑定、运行状态都要能看见。',
      items: [
        { alt: '飞书流式卡片截图', caption: '飞书 / Lark 里的实时卡片流', src: larkCardProof },
        { alt: '终端扫码向导截图', caption: '首次启动时的终端扫码与绑定流程', src: qrWizardProof },
        { alt: '运行状态截图', caption: 'status / workers / retry 这类运维视角证据', src: opsPanelProof },
      ],
    },
```

In the English copy object, add:

```ts
    proof: {
      heading: 'Real product proof',
      body: 'Put the actual product right under the hero: a live card, the QR/start flow, and an operational status view.',
      items: [
        { alt: 'Lark streaming card screenshot', caption: 'Streaming card inside Lark / Feishu', src: larkCardProof },
        { alt: 'Terminal QR wizard screenshot', caption: 'First-run terminal QR and bind flow', src: qrWizardProof },
        { alt: 'Operational status screenshot', caption: 'Operational proof for status / workers / retry', src: opsPanelProof },
      ],
    },
```

Replace `site/src/App.tsx` with:

```tsx
import { useState } from 'react';
import { HeroSection } from './components/HeroSection';
import { LanguageToggle } from './components/LanguageToggle';
import { ProofStrip } from './components/ProofStrip';
import { copy, type Locale } from './content/copy';

export default function App() {
  const [locale, setLocale] = useState<Locale>('zh');
  const content = copy[locale];

  return (
    <main className="site-shell">
      <header className="site-nav">
        <span className="brand">lark-agent-bridge</span>
        <nav className="nav-links" aria-label="Primary">
          <a href={content.nav.githubHref}>{content.nav.githubLabel}</a>
          <a href={content.nav.docsHref}>{content.nav.docsLabel}</a>
        </nav>
        <LanguageToggle locale={locale} onChange={setLocale} />
      </header>
      <HeroSection copy={content.hero} />
      <ProofStrip heading={content.proof.heading} body={content.proof.body} items={content.proof.items} />
    </main>
  );
}
```

Append these blocks to `site/src/styles.css`:

```css
.proof-strip {
  display: grid;
  gap: 20px;
  padding: 56px 0;
}

.section-copy {
  display: grid;
  gap: 10px;
  max-width: 70ch;
}

.section-copy h2,
.section-copy p {
  margin: 0;
}

.section-kicker {
  color: #89e5c8;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.proof-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.proof-card {
  margin: 0;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.proof-card img {
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
}

.proof-card figcaption {
  margin-top: 10px;
  color: #ced9ef;
  line-height: 1.5;
}
```

- [ ] **Step 5: Re-run the proof test and build**

Run: `npm --prefix site test -- src/App.test.tsx && npm --prefix site run build`

Expected: the proof-strip test passes and the build includes hashed proof assets.

- [ ] **Step 6: Commit the proof work**

```bash
git add site/src/components/ProofStrip.tsx site/src/assets/proof/lark-card.png site/src/assets/proof/qr-wizard.png site/src/assets/proof/ops-panel.png site/src/content/copy.ts site/src/App.tsx site/src/styles.css site/src/App.test.tsx
git commit -m "feat: add homepage proof strip"
```

---

### Task 4: Add the capability grid and architecture band

**Files:**
- Create: `site/src/components/CapabilityGrid.tsx`
- Create: `site/src/components/ArchitectureBand.tsx`
- Modify: `site/src/content/copy.ts`
- Modify: `site/src/App.tsx`
- Modify: `site/src/styles.css`
- Modify: `site/src/App.test.tsx`

- [ ] **Step 1: Add a failing capability-and-architecture test**

Append this test to `site/src/App.test.tsx`:

```tsx
test('explains the workbench capabilities and the bridge architecture', () => {
  render(<App />);

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
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm --prefix site test -- src/App.test.tsx`

Expected: FAIL because those sections and labels are not rendered yet.

- [ ] **Step 3: Add the capability and architecture components**

Create `site/src/components/CapabilityGrid.tsx`:

```tsx
interface CapabilityItem {
  title: string;
  body: string;
  chips: string[];
}

interface CapabilityGridProps {
  heading: string;
  body: string;
  items: CapabilityItem[];
}

export function CapabilityGrid({ heading, body, items }: CapabilityGridProps) {
  return (
    <section className="capability-section" aria-labelledby="capability-heading">
      <div className="section-copy">
        <p className="section-kicker">Capabilities</p>
        <h2 id="capability-heading">{heading}</h2>
        <p>{body}</p>
      </div>
      <div className="capability-grid">
        {items.map((item) => (
          <article key={item.title} className="capability-card">
            <h3>{item.title}</h3>
            <p>{item.body}</p>
            <div className="badge-row">
              {item.chips.map((chip) => (
                <span key={chip} className="status-chip">
                  {chip}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
```

Create `site/src/components/ArchitectureBand.tsx`:

```tsx
interface ArchitectureBandProps {
  heading: string;
  body: string;
  nodes: string[];
}

export function ArchitectureBand({ heading, body, nodes }: ArchitectureBandProps) {
  return (
    <section className="architecture-band" aria-labelledby="architecture-heading">
      <div className="section-copy">
        <p className="section-kicker">Flow</p>
        <h2 id="architecture-heading">{heading}</h2>
        <p>{body}</p>
      </div>
      <div className="architecture-row" aria-label="Bridge flow">
        {nodes.map((node) => (
          <div key={node} className="architecture-node">
            {node}
          </div>
        ))}
      </div>
    </section>
  );
}
```

In `HomeCopy`, add:

```ts
  capabilities: {
    heading: string;
    body: string;
    items: { title: string; body: string; chips: string[] }[];
  };
  architecture: {
    heading: string;
    body: string;
    nodes: string[];
  };
```

In the Chinese copy object, add:

```ts
    capabilities: {
      heading: '为什么它是工程工作台，而不是普通 bot',
      body: '页面中段要把 backend、workspace、session、retry、诊断这些能力讲明白，让人知道它是日常工程入口。',
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
```

In the English copy object, add:

```ts
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
```

Replace `site/src/App.tsx` with:

```tsx
import { useState } from 'react';
import { ArchitectureBand } from './components/ArchitectureBand';
import { CapabilityGrid } from './components/CapabilityGrid';
import { HeroSection } from './components/HeroSection';
import { LanguageToggle } from './components/LanguageToggle';
import { ProofStrip } from './components/ProofStrip';
import { copy, type Locale } from './content/copy';

export default function App() {
  const [locale, setLocale] = useState<Locale>('zh');
  const content = copy[locale];

  return (
    <main className="site-shell">
      <header className="site-nav">
        <span className="brand">lark-agent-bridge</span>
        <nav className="nav-links" aria-label="Primary">
          <a href={content.nav.githubHref}>{content.nav.githubLabel}</a>
          <a href={content.nav.docsHref}>{content.nav.docsLabel}</a>
        </nav>
        <LanguageToggle locale={locale} onChange={setLocale} />
      </header>
      <HeroSection copy={content.hero} />
      <ProofStrip heading={content.proof.heading} body={content.proof.body} items={content.proof.items} />
      <CapabilityGrid
        heading={content.capabilities.heading}
        body={content.capabilities.body}
        items={content.capabilities.items}
      />
      <ArchitectureBand
        heading={content.architecture.heading}
        body={content.architecture.body}
        nodes={content.architecture.nodes}
      />
    </main>
  );
}
```

Append these blocks to `site/src/styles.css`:

```css
.capability-section,
.architecture-band {
  display: grid;
  gap: 20px;
  padding: 56px 0;
}

.capability-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.capability-card {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.capability-card h3,
.capability-card p {
  margin: 0;
}

.architecture-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.architecture-node {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02));
  text-align: center;
}
```

- [ ] **Step 4: Re-run the capability/architecture test and build**

Run: `npm --prefix site test -- src/App.test.tsx && npm --prefix site run build`

Expected: the new test passes and the build still succeeds with the added sections.

- [ ] **Step 5: Commit the mid-page sections**

```bash
git add site/src/components/CapabilityGrid.tsx site/src/components/ArchitectureBand.tsx site/src/content/copy.ts site/src/App.tsx site/src/styles.css site/src/App.test.tsx
git commit -m "feat: add homepage capability and architecture sections"
```

---

### Task 5: Add quickstart, commands, footer links, and Chinese-first docs routing

**Files:**
- Create: `site/src/components/QuickstartSection.tsx`
- Create: `site/src/components/SiteFooter.tsx`
- Modify: `site/src/content/copy.ts`
- Modify: `site/src/App.tsx`
- Modify: `site/src/styles.css`
- Modify: `site/src/App.test.tsx`

- [ ] **Step 1: Add a failing setup-and-links test**

Append this test to `site/src/App.test.tsx`:

```tsx
test('shows quickstart, operator commands, and repo/doc links', () => {
  render(<App />);

  expect(screen.getByRole('heading', { name: '快速开始与运维入口' })).toBeInTheDocument();
  expect(screen.getByText('/ws')).toBeInTheDocument();
  expect(screen.getByText('/new worktree')).toBeInTheDocument();
  expect(screen.getByText('/workers')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '中文 README' })).toHaveAttribute(
    'href',
    'https://github.com/fangpin/lark-agent-bridge/blob/main/README.zh.md',
  );
  expect(screen.getByRole('link', { name: 'English README' })).toHaveAttribute(
    'href',
    'https://github.com/fangpin/lark-agent-bridge/blob/main/README.md',
  );
  expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/fangpin/lark-agent-bridge',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix site test -- src/App.test.tsx`

Expected: FAIL because the quickstart/footer section and those links do not exist yet.

- [ ] **Step 3: Add the quickstart/footer components and docs-link content**

Create `site/src/components/QuickstartSection.tsx`:

```tsx
interface QuickstartSectionProps {
  heading: string;
  body: string;
  command: string;
  setupSteps: string[];
  commands: string[];
  docs: { label: string; href: string }[];
}

export function QuickstartSection({
  heading,
  body,
  command,
  setupSteps,
  commands,
  docs,
}: QuickstartSectionProps) {
  return (
    <section className="quickstart-section" id="quickstart" aria-labelledby="quickstart-heading">
      <div className="section-copy">
        <p className="section-kicker">Setup</p>
        <h2 id="quickstart-heading">{heading}</h2>
        <p>{body}</p>
      </div>
      <div className="quickstart-grid">
        <article className="setup-card">
          <div className="panel-label">Install / Start</div>
          <code>{command}</code>
          <ul className="hero-note-list">
            {setupSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </article>
        <article className="setup-card">
          <div className="panel-label">Commands</div>
          <div className="badge-row">
            {commands.map((commandName) => (
              <span key={commandName} className="status-chip">
                {commandName}
              </span>
            ))}
          </div>
        </article>
        <article className="setup-card">
          <div className="panel-label">Docs</div>
          <div className="docs-link-list">
            {docs.map((doc) => (
              <a key={doc.href} href={doc.href}>
                {doc.label}
              </a>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}
```

Create `site/src/components/SiteFooter.tsx`:

```tsx
interface FooterLink {
  label: string;
  href: string;
}

interface SiteFooterProps {
  links: FooterLink[];
  note: string;
}

export function SiteFooter({ links, note }: SiteFooterProps) {
  return (
    <footer className="site-footer">
      <div className="docs-link-list">
        {links.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
      </div>
      <p>{note}</p>
    </footer>
  );
}
```

In `HomeCopy`, add:

```ts
  quickstart: {
    heading: string;
    body: string;
    command: string;
    setupSteps: string[];
    commands: string[];
    docs: { label: string; href: string }[];
  };
  footer: {
    links: { label: string; href: string }[];
    note: string;
  };
```

In the Chinese copy object, add:

```ts
    quickstart: {
      heading: '快速开始与运维入口',
      body: '在首屏之后立刻给出启动命令、首启说明、常用斜杠命令和文档入口，默认先指向中文资料。',
      command: 'npx -y lark-agent-bridge@latest start',
      setupSteps: [
        '首次启动会出现扫码向导，用飞书 / Lark 绑定 PersonalAgent。',
        '确认权限 scope 与事件订阅后，再次启动即可开始在聊天里 @bot。',
        '使用 /cd、/ws、/new worktree 把 bridge 绑定到你的本地 repo。'
      ],
      commands: ['/ws', '/new worktree', '/retry', '/status', '/workers', '/doctor'],
      docs: [
        { label: '中文 README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.zh.md' },
        { label: '中文介绍', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/docs/lark-agent-bridge-intro.zh.md' },
        { label: 'English README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.md' }
      ],
    },
    footer: {
      links: [
        { label: 'GitHub', href: 'https://github.com/fangpin/lark-agent-bridge' },
        { label: '中文 README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.zh.md' },
        { label: 'English README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.md' }
      ],
      note: 'bridge 运行在本机，依赖你本地已安装并登录的 agent backend。',
    },
```

In the English copy object, add:

```ts
    quickstart: {
      heading: 'Quickstart and operator entry points',
      body: 'Put the install/start command, first-run notes, slash commands, and doc links together, while still defaulting to Chinese on first load.',
      command: 'npx -y lark-agent-bridge@latest start',
      setupSteps: [
        'The first launch opens a QR wizard so you can bind a PersonalAgent in Lark / Feishu.',
        'Confirm scopes and event subscriptions, then start the bridge again to begin chatting.',
        'Use /cd, /ws, and /new worktree to bind the bridge to the right local repo.'
      ],
      commands: ['/ws', '/new worktree', '/retry', '/status', '/workers', '/doctor'],
      docs: [
        { label: 'Chinese README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.zh.md' },
        { label: 'Chinese intro', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/docs/lark-agent-bridge-intro.zh.md' },
        { label: 'English README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.md' }
      ],
    },
    footer: {
      links: [
        { label: 'GitHub', href: 'https://github.com/fangpin/lark-agent-bridge' },
        { label: 'Chinese README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.zh.md' },
        { label: 'English README', href: 'https://github.com/fangpin/lark-agent-bridge/blob/main/README.md' }
      ],
      note: 'The bridge runs locally and depends on locally installed, logged-in agent backends.',
    },
```

Replace `site/src/App.tsx` with:

```tsx
import { useState } from 'react';
import { ArchitectureBand } from './components/ArchitectureBand';
import { CapabilityGrid } from './components/CapabilityGrid';
import { HeroSection } from './components/HeroSection';
import { LanguageToggle } from './components/LanguageToggle';
import { ProofStrip } from './components/ProofStrip';
import { QuickstartSection } from './components/QuickstartSection';
import { SiteFooter } from './components/SiteFooter';
import { copy, type Locale } from './content/copy';

export default function App() {
  const [locale, setLocale] = useState<Locale>('zh');
  const content = copy[locale];

  return (
    <main className="site-shell">
      <header className="site-nav">
        <span className="brand">lark-agent-bridge</span>
        <nav className="nav-links" aria-label="Primary">
          <a href={content.nav.githubHref}>{content.nav.githubLabel}</a>
          <a href={content.nav.docsHref}>{content.nav.docsLabel}</a>
        </nav>
        <LanguageToggle locale={locale} onChange={setLocale} />
      </header>
      <HeroSection copy={content.hero} />
      <ProofStrip heading={content.proof.heading} body={content.proof.body} items={content.proof.items} />
      <CapabilityGrid
        heading={content.capabilities.heading}
        body={content.capabilities.body}
        items={content.capabilities.items}
      />
      <ArchitectureBand
        heading={content.architecture.heading}
        body={content.architecture.body}
        nodes={content.architecture.nodes}
      />
      <QuickstartSection
        heading={content.quickstart.heading}
        body={content.quickstart.body}
        command={content.quickstart.command}
        setupSteps={content.quickstart.setupSteps}
        commands={content.quickstart.commands}
        docs={content.quickstart.docs}
      />
      <SiteFooter links={content.footer.links} note={content.footer.note} />
    </main>
  );
}
```

Append these blocks to `site/src/styles.css`:

```css
.quickstart-section {
  display: grid;
  gap: 20px;
  padding: 56px 0;
}

.quickstart-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.setup-card {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.docs-link-list {
  display: grid;
  gap: 10px;
}

.docs-link-list a {
  color: #f5fbff;
  text-decoration: none;
}

.site-footer {
  display: grid;
  gap: 14px;
  padding: 48px 0 24px;
  color: #c6d3e9;
}

.site-footer p {
  margin: 0;
}
```

- [ ] **Step 4: Re-run tests and build**

Run: `npm --prefix site test -- src/App.test.tsx && npm --prefix site run build`

Expected: the new test passes and the quickstart/footer section renders the Chinese-first doc links.

- [ ] **Step 5: Commit the setup/footer work**

```bash
git add site/src/components/QuickstartSection.tsx site/src/components/SiteFooter.tsx site/src/content/copy.ts site/src/App.tsx site/src/styles.css site/src/App.test.tsx
git commit -m "feat: add homepage quickstart and docs links"
```

---

### Task 6: Add GitHub Pages deployment and wire the homepage back into the repo

**Files:**
- Create: `.github/workflows/pages.yml`
- Modify: `README.md`
- Modify: `README.zh.md`

- [ ] **Step 1: Add the GitHub Pages workflow**

Create `.github/workflows/pages.yml`:

```yaml
name: deploy-pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: github-pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: site/package-lock.json

      - uses: actions/configure-pages@v5

      - name: Install site deps
        run: npm ci
        working-directory: site

      - name: Build homepage
        run: npm run build
        working-directory: site

      - uses: actions/upload-pages-artifact@v3
        with:
          path: site/dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Add the homepage link to both READMEs**

In `README.md`, directly under the first paragraph, add:

```md
Homepage: [fangpin.github.io/lark-agent-bridge](https://fangpin.github.io/lark-agent-bridge/)
```

In `README.zh.md`, directly under the first paragraph, add:

```md
项目主页：[fangpin.github.io/lark-agent-bridge](https://fangpin.github.io/lark-agent-bridge/)
```

- [ ] **Step 3: Run the full site test/build verification**

Run: `npm --prefix site test && npm --prefix site run build`

Expected: all homepage tests pass and `site/dist/index.html` is regenerated successfully.

- [ ] **Step 4: Verify the Pages base path and README links**

Run:

```bash
rg -n "/lark-agent-bridge/assets/" site/dist/index.html
rg -n "fangpin.github.io/lark-agent-bridge" README.md README.zh.md
```

Expected:

- `site/dist/index.html` contains a `/lark-agent-bridge/assets/` reference.
- both READMEs contain the homepage URL.

- [ ] **Step 5: Preview the site locally and do the responsive smoke check**

Run: `npm --prefix site run preview -- --host 127.0.0.1 --port 4173`

Expected: Vite preview listens on `http://127.0.0.1:4173/lark-agent-bridge/`.

Manual check in the browser:

- desktop width around `1440px`: hero headline, cockpit panel, quickstart command, and proof strip appear without overlap;
- mobile width around `390px`: nav, hero copy, quickstart command, and first proof image remain readable and stacked cleanly;
- locale toggle still defaults to Chinese and can switch to English.

- [ ] **Step 6: Commit the deployment and README integration**

```bash
git add .github/workflows/pages.yml README.md README.zh.md
git commit -m "feat: publish GitHub Pages homepage"
```

---

## Self-Review

- Spec coverage:
  - `site/` isolated static app: Tasks 1-5.
  - Chinese default + English toggle: Tasks 1-2.
  - Demo-first command-center hero: Task 2.
  - Real proof near the hero: Task 3.
  - Capability, architecture, quickstart, commands, footer: Tasks 4-5.
  - GitHub Pages deployment + README back-links: Task 6.
- Placeholder scan: no `TODO`, `TBD`, or “similar to above” shortcuts remain.
- Type consistency:
  - locale keys stay `zh` / `en` across `App.tsx`, `copy.ts`, and `LanguageToggle.tsx`;
  - all section props are declared in their component files before use;
  - the homepage command stays `npx -y lark-agent-bridge@latest start` across hero and quickstart content.
