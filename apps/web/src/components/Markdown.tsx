import { useEffect, useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';
import { Copy, Check, WrapText } from 'lucide-react';
import { openExternalLink } from '../lib/externalLink';
import { postJSON } from '../lib/api/core';
import { cn } from './ui';

// Per-workspace data-URL cache: the same image path can appear many times in
// a long transcript, and each <img> mounts its own ImageWithFallback. Without
// a cache that's one fs/b64 round trip per mount (plus a re-fetch on every
// remount). Keyed on workspace + cleaned path.
const imageCache = new Map<string, string>();

function ImageWithFallback({ src, alt, workspace }: { src?: string; alt?: string; workspace?: string }) {
  const isRemote = !src || /^(https?:|data:|blob:)/.test(src);
  const [resolvedSrc, setResolvedSrc] = useState(isRemote ? (src || '') : '');

  useEffect(() => {
    if (!src) return;
    if (isRemote) {
      setResolvedSrc(src);
      return;
    }
    let live = true;
    let clean = src.replace(/^file:\/\//, '');
    if (clean.startsWith('<repo-root>/')) clean = clean.replace('<repo-root>/', '');
    if (clean.startsWith('./')) clean = clean.slice(2);
    const cacheKey = `${workspace ?? ''}\0${clean}`;
    const cached = imageCache.get(cacheKey);
    if (cached) {
      setResolvedSrc(cached);
      return;
    }
    // Leave the previous src in place while loading — no broken-image flash.
    postJSON<{ dataUrl?: string }>('/api/coder/fs/b64', { path: clean, workspace }, 5000)
      .then((res) => {
        if (live && res?.dataUrl) {
          imageCache.set(cacheKey, res.dataUrl);
          setResolvedSrc(res.dataUrl);
        }
      })
      .catch(() => {
        // Keep the original src so the browser shows its own broken-image
        // state rather than silently rendering nothing.
      });

    return () => {
      live = false;
    };
  }, [src, isRemote, workspace]);

  if (!resolvedSrc) return null;
  return (
    <img
      src={resolvedSrc}
      alt={alt || ''}
      className="my-2 max-h-[300px] object-contain rounded-md border border-line bg-panel2 shadow-sm"
      loading="lazy"
    />
  );
}

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
  const [wrapped, setWrapped] = useState(false);

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
    <div className="mdcode my-2.5 overflow-hidden rounded-lg border border-line bg-inset shadow-2xs">
      <div className="flex items-center justify-between border-b border-line bg-panel2/60 px-3 py-1 text-[11px]">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-faint font-semibold">{lang || 'text'}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setWrapped((w) => !w)}
            title={wrapped ? 'Unwrap lines' : 'Wrap lines'}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors',
              wrapped ? 'bg-accent/20 text-accent font-semibold' : 'text-faint hover:text-ink hover:bg-panel2'
            )}
          >
            <WrapText size={12} />
            <span>wrap</span>
          </button>
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-mute transition-colors hover:bg-panel2 hover:text-ink"
          >
            {copied ? (
              <>
                <Check size={12} className="text-accent" />
                <span className="text-accent font-semibold">copied</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span>copy</span>
              </>
            )}
          </button>
        </div>
      </div>
      <pre className={cn("p-3 text-[12px] font-mono leading-relaxed", wrapped ? "whitespace-pre-wrap break-words" : "overflow-x-auto")}>
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
export function Markdown({ children, workspace }: { children: string; workspace?: string }) {
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
          return <ImageWithFallback src={src} alt={alt} workspace={workspace} />;
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

// Default export so callers can `lazy(() => import('./Markdown'))` — this
// module pulls in react-markdown + remark-gfm + highlight.js's full language
// grammar table, ~300KB that's otherwise parsed/executed on startup even
// though nothing needs it until the first completed reply actually renders.
export default Markdown;
