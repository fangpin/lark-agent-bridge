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
