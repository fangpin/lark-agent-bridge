import { useEffect, useMemo, useState } from 'react';
import { ArchitectureBand } from './components/ArchitectureBand';
import { CapabilityGrid } from './components/CapabilityGrid';
import { DocsLayout } from './components/DocsLayout';
import { HeroSection } from './components/HeroSection';
import { LanguageToggle } from './components/LanguageToggle';
import { ProofStrip } from './components/ProofStrip';
import { QuickstartSection } from './components/QuickstartSection';
import { SiteFooter } from './components/SiteFooter';
import { copy, type Locale } from './content/copy';
import { docsContent } from './content/docs';

type Route = { view: 'home' } | { view: 'docs'; slug?: string };

function readRoute(hash: string): Route {
  const normalized = hash.replace(/^#/, '').replace(/^\/+/, '');
  if (!normalized || normalized === 'home') return { view: 'home' };
  const [root, slug] = normalized.split('/');
  if (root === 'docs') return { view: 'docs', slug };
  return { view: 'home' };
}

export default function App() {
  const [locale, setLocale] = useState<Locale>('zh');
  const [route, setRoute] = useState<Route>(() => readRoute(window.location.hash));
  const content = copy[locale];
  const docs = docsContent[locale];
  const currentDoc = useMemo(() => {
    const fallback = docs.chapters[0];
    if (route.view !== 'docs') return fallback;
    return docs.chapters.find((chapter) => chapter.slug === route.slug) ?? fallback;
  }, [docs, route]);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  useEffect(() => {
    const title =
      route.view === 'docs'
        ? `lark-agent-bridge · ${currentDoc.title}`
        : 'lark-agent-bridge';
    document.title = title;
    if (typeof window.scrollTo === 'function') {
      try {
        window.scrollTo(0, 0);
      } catch {
        // jsdom does not implement scrollTo.
      }
    }
  }, [currentDoc.title, route.view]);

  return (
    <main className="site-shell">
      <header className="site-nav">
        <a className="brand brand-link" href="#home">
          lark-agent-bridge
        </a>
        <nav className="nav-links" aria-label="Primary">
          <a href={content.nav.githubHref}>{content.nav.githubLabel}</a>
          <a href={content.nav.docsHref} aria-current={route.view === 'docs' ? 'page' : undefined}>
            {content.nav.docsLabel}
          </a>
        </nav>
        <LanguageToggle locale={locale} onChange={setLocale} />
      </header>
      {route.view === 'docs' ? (
        <DocsLayout content={docs} currentChapter={currentDoc} />
      ) : (
        <>
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
        </>
      )}
      <SiteFooter links={content.footer.links} note={content.footer.note} />
    </main>
  );
}
