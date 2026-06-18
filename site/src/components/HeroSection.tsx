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
        <div className="cockpit-card cockpit-card-message">
          <div className="panel-label">Lark thread</div>
          <p>@bot trace this failing test and patch it in the current repo</p>
        </div>
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
        <div className="stream-card">
          <div className="stream-card-header">
            <span>Streaming card</span>
            <span className="status-live">agent active</span>
          </div>
          <div className="stream-card-line stream-card-line-strong" />
          <div className="stream-card-line stream-card-line-mid" />
          <div className="stream-card-line stream-card-line-short" />
          <div className="stream-progress">
            <span>task phase</span>
            <div className="stream-progress-track">
              <div className="stream-progress-bar" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
