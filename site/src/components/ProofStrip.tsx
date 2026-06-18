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
