/**
 * Renders release notes (markdownParse.ts) as React elements: no HTML is ever
 * parsed. A link asks first, then opens in the system browser (main allows
 * only http and https).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog.js';
import { parseMarkdown, type Inline } from './markdownParse.js';

function inlines(items: Inline[], onLink: (href: string) => void): ReactNode[] {
  return items.map((item, index) => {
    switch (item.kind) {
      case 'text':
        return item.text;
      case 'code':
        return <code key={index}>{item.text}</code>;
      case 'strong':
        return <strong key={index}>{inlines(item.children, onLink)}</strong>;
      case 'em':
        return <em key={index}>{inlines(item.children, onLink)}</em>;
      case 'link':
        return (
          <button
            key={index}
            type="button"
            className="link-btn md-link"
            title={item.href}
            onClick={() => onLink(item.href)}
          >
            {inlines(item.children, onLink)}
          </button>
        );
    }
  });
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const [link, setLink] = useState<string | null>(null);
  const onLink = (href: string) => setLink(href);
  return (
    <div className={`markdown${className ? ` ${className}` : ''}`}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = block.level === 1 ? 'h4' : block.level === 2 ? 'h5' : 'h6';
            return <Tag key={index}>{inlines(block.children, onLink)}</Tag>;
          }
          case 'paragraph':
            return <p key={index}>{inlines(block.children, onLink)}</p>;
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <List key={index}>
                {block.items.map((item, n) => (
                  <li key={n}>{inlines(item, onLink)}</li>
                ))}
              </List>
            );
          }
          case 'code':
            return (
              <pre key={index}>
                <code>{block.text}</code>
              </pre>
            );
          case 'rule':
            return <hr key={index} />;
        }
      })}
      {link && (
        <Dialog
          title="Open this link?"
          onClose={() => setLink(null)}
          submitLabel="Open in browser"
          onSubmit={() => {
            window.quqa.openExternal(link);
            setLink(null);
          }}
        >
          <p className="system-hint">It opens in your web browser:</p>
          <p className="link-confirm-url">{link}</p>
        </Dialog>
      )}
    </div>
  );
}
