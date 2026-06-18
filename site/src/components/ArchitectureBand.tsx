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
        {nodes.map((node, index) => (
          <div key={node} className="architecture-node">
            <span>{node}</span>
            {index < nodes.length - 1 ? <span className="architecture-arrow">→</span> : null}
          </div>
        ))}
      </div>
    </section>
  );
}
