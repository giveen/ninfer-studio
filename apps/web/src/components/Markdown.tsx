import { useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';
import { openExternalLink } from '../lib/externalLink';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as unknown as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

function langOf(node: ReactNode): string {
  if (node && typeof node === 'object' && 'props' in node) {
    const cls = (node as unknown as { props: { className?: string } }).props.className;
    const m = /language-([\w+-]+)/.exec(cls || '');
    if (m) return m[1];
  }
  return '';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="mdcode my-2.5 overflow-hidden rounded-lg border border-line bg-inset">
      <div className="flex items-center justify-between border-b border-line px-3 py-1">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-faint">{lang || 'text'}</span>
        <button
          type="button"
          onClick={copy}
          className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-mute transition-colors hover:bg-panel2 hover:text-ink"
        >
          {copied ? 'copied ✓' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

/**
 * Chat markdown: GFM + syntax-highlighted code blocks with a copy button.
 * Inline code keeps the default (styled) rendering; fenced blocks get the
 * header bar + highlight.js tokens.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => {
          const code = textOf(children);
          const lang = langOf(children);
          return <CodeBlock code={code} lang={lang} />;
        },
        code: ({ className, children, node: _node }) => {
          // inline code (block code is handled by the pre override)
          const cls = /language-[\w+-]+/.test(className || '') ? '' : className;
          return <code className={cls}>{children}</code>;
        },
        img: ({ src, alt }) => {
          return (
            <img
              src={src}
              alt={alt || ''}
              className="my-2 max-h-[300px] object-contain rounded-md border border-line bg-panel2 shadow-sm"
              loading="lazy"
            />
          );
        },
        a: ({ href, children }) => {
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline transition-colors break-words"
              onClick={(e) => openExternalLink(e, href)}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
