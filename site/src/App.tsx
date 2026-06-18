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
