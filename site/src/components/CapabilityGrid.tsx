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
