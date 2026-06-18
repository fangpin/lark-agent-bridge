import type { DocChapter, DocsContent } from '../content/docs';
import { MarkdownArticle } from './MarkdownArticle';

interface DocsLayoutProps {
  content: DocsContent;
  currentChapter: DocChapter;
}

export function DocsLayout({ content, currentChapter }: DocsLayoutProps) {
  const overviewSlug = content.chapters[0]?.slug;
  const chapterCards = content.chapters.filter((chapter) => chapter.slug !== overviewSlug);

  return (
    <section className="docs-shell" aria-labelledby="docs-title">
      <aside className="docs-sidebar">
        <div className="docs-sidebar-panel">
          <p className="section-kicker">{content.eyebrow}</p>
          <h1 id="docs-title">{content.title}</h1>
          <p>{content.body}</p>
          <div className="docs-sidebar-links">
            <a href={content.homeHref}>{content.homeLabel}</a>
            <a href={content.githubHref}>{content.githubLabel}</a>
          </div>
        </div>

        <nav className="docs-sidebar-panel" aria-label={content.chapterListLabel}>
          <div className="panel-label">{content.chapterListLabel}</div>
          <div className="doc-nav-list">
            {content.chapters.map((chapter) => (
              <a
                key={chapter.slug}
                className="doc-nav-link"
                href={`#docs/${chapter.slug}`}
                aria-current={currentChapter.slug === chapter.slug ? 'page' : undefined}
              >
                <span className="doc-nav-link-title">{chapter.title}</span>
                <span className="doc-nav-link-summary">{chapter.summary}</span>
              </a>
            ))}
          </div>
        </nav>
      </aside>

      <article className="docs-article">
        <div className="doc-meta">
          <span>
            {content.sourceLabel}: <code>{currentChapter.sourcePath}</code>
          </span>
          <span>
            <a href={content.githubHref}>{content.githubLabel}</a>
          </span>
        </div>
        <p className="doc-article-lead">{currentChapter.summary}</p>
        <MarkdownArticle markdown={currentChapter.markdown} />

        {currentChapter.slug === overviewSlug ? (
          <section className="docs-grid" aria-labelledby="chapter-map-heading">
            <div className="docs-grid-header">
              <h2 id="chapter-map-heading">{content.chapterMapHeading}</h2>
              <p>{content.chapterMapBody}</p>
            </div>
            <div className="chapter-grid">
              {chapterCards.map((chapter) => (
                <a key={chapter.slug} className="chapter-card" href={`#docs/${chapter.slug}`}>
                  <h3>{chapter.title}</h3>
                  <p>{chapter.summary}</p>
                  <code>{chapter.sourcePath}</code>
                </a>
              ))}
            </div>
          </section>
        ) : null}
      </article>
    </section>
  );
}
