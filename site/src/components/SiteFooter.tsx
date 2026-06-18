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
