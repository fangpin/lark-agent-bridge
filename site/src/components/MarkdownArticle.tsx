import ReactMarkdown from 'react-markdown';

interface MarkdownArticleProps {
  markdown: string;
}

export function MarkdownArticle({ markdown }: MarkdownArticleProps) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        components={{
          a({ href, children, ...props }) {
            const external = typeof href === 'string' && /^https?:\/\//.test(href);
            return (
              <a
                href={href}
                target={external ? '_blank' : undefined}
                rel={external ? 'noreferrer' : undefined}
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
