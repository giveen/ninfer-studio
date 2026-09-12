import React, { useState, lazy, Suspense } from 'react';
import { ChevronDown, HelpCircle, BrainCircuit } from 'lucide-react';
import { ChatMessage } from '../lib/types';
import { CodeBlock, cn } from './ui';
import { openExternalLink } from '../lib/externalLink';

// Dynamically imported: react-markdown + remark-gfm + highlight.js is a
// ~300KB chunk that costs nothing at startup this way, only when the first
// completed reply actually needs to render (see ChatScreen.tsx and
// CoderScreen.tsx, which share this same lazy module — every consumer must
// use dynamic import or Rollup folds the chunk back into the eager bundle
// for all of them).
const Markdown = lazy(() => import('./Markdown'));

/** High-precision secret shapes redacted from displayed tool output + ledger.
 *  Display-layer only: model context is untouched so code still executes. */
const SECRET_RES: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[bpas]-[A-Za-z0-9-]{10,}/g,
  /sk-ant-[A-Za-z0-9-_]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}/g,
];
export const redactSecrets = (s: string): string => {
  let o = s ?? '';
  for (const re of SECRET_RES) {
    re.lastIndex = 0;
    o = o.replace(re, '[redacted]');
  }
  return o;
};

export function BashResultView({ data }: { data: any }) {
  return (
    <div className="rounded-md bg-[#1e1e1e] text-[#d4d4d4] font-mono text-[11px] overflow-hidden mt-1">
      <div className="bg-[#2d2d2d] px-2 py-1 flex justify-between items-center text-[#858585]">
        <span>Terminal {data.jobId ? `(background job ${data.jobId} — poll with bash_poll)` : data.exitCode !== null && data.exitCode !== undefined ? `(exit ${data.exitCode})` : ''}</span>
        <span className="flex items-center gap-2">
          {data.blocked && <span className="text-danger font-semibold">Blocked by safe mode</span>}
          {data.timedOut && <span className="text-warn">Timeout</span>}
        </span>
      </div>
      <div className="p-2 overflow-auto max-h-64 whitespace-pre">
        {data.stdout && <div>{redactSecrets(data.stdout)}</div>}
        {data.stderr && <div className="text-danger">{redactSecrets(data.stderr)}</div>}
        {!data.stdout && !data.stderr && <div className="text-faint italic">No output</div>}
        {data.blocked && <div className="mt-1 border-t border-[#3a3a3a] pt-1 text-[#858585]">The model can ask for one-off approval via ask_user — approve only for trusted workspaces (Safe Mode toggle in the sidebar).</div>}
      </div>
    </div>
  );
}

export function ReadResultView({ data }: { data: any }) {
  return (
    <div className="mt-1">
       <CodeBlock code={redactSecrets(data.content || '')} />
    </div>
  );
}

export function WebSearchResultView({ data }: { data: any }) {
  return (
    <div className="mt-1 p-3 bg-panel border border-line rounded-lg flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-mute border-b border-line pb-1.5">
        <span>🔍</span> <span>Search Results for "{data.query}"</span>
      </div>
      <div className="space-y-3 max-h-64 overflow-auto pt-1">
        {data.results?.length === 0 && <div className="text-faint text-xs italic">No results found.</div>}
        {data.results?.map((r: any, i: number) => (
          <div key={i} className="flex flex-col gap-0.5">
            <a href={r.url} target="_blank" rel="noreferrer" className="text-[11px] text-accent hover:underline truncate" onClick={(e) => openExternalLink(e, r.url)}>{r.url}</a>
            <div className="text-[11px] text-mute line-clamp-2">{r.snippet}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WebFetchResultView({ data }: { data: any }) {
  return (
    <div className="mt-1 rounded-lg border border-line bg-panel overflow-hidden">
      <div className="bg-panel2 px-3 py-1.5 border-b border-line flex items-center gap-2">
        <span className="text-[10px] bg-inset border border-line rounded px-1.5 py-0.5 text-faint">GET</span>
        <span className="text-[11px] font-mono text-mute truncate flex-1">{data.url}</span>
        {data.status && <span className={cn("text-[10px] font-medium", data.status >= 400 ? 'text-danger' : 'text-ok')}>{data.status}</span>}
      </div>
      <div className="p-3 max-h-64 overflow-auto text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink bg-panel">
        {data.content ? redactSecrets(data.content) : <span className="italic text-faint">No content extracted.</span>}
        {data.truncated && <div className="mt-2 text-warn italic border-t border-line pt-1 text-[10px]">Content truncated due to length limits.</div>}
      </div>
    </div>
  );
}

/** Shared by `write`/`edit`/`apply_patch`: a status line, an optional diff
 *  preview, and optional lint/test failure output. */
export function FileMutationResultView({ data, label }: { data: any, label: string }) {
  return (
    <div className="mt-1 p-2 bg-ok/10 border border-ok/30 rounded-md text-[11px] text-ok font-mono">
      {label}
      {data.preview_diff && <div className="mt-1.5"><CodeBlock code={redactSecrets(data.preview_diff)} /></div>}
      {data.linter_error && <div className="mt-1.5 whitespace-pre-wrap text-danger">Lint failed:{'\n'}{redactSecrets(String(data.linter_error)).slice(0, 2000)}</div>}
      {data.test_error && <div className="mt-1.5 whitespace-pre-wrap text-danger">Tests failed:{'\n'}{redactSecrets(String(data.test_error)).slice(0, 2000)}</div>}
    </div>
  );
}

export function RawJsonResultView({ data }: { data: any }) {
  return (
    <div className="mt-1 p-2 bg-inset border border-line rounded-md text-[11px] font-mono overflow-auto max-h-48 whitespace-pre">
      {redactSecrets(JSON.stringify(data, null, 2))}
    </div>
  );
}

export function AskUserResultView({ data, content }: { data: any, content: string }) {
  return (
    <div className="mt-1 p-2 bg-accent/10 border border-accent/30 rounded-md text-[11px] text-ink">
      <div className="font-semibold text-accent mb-0.5 flex items-center gap-1">
        <HelpCircle size={12} /> Agent asked:
      </div>
      <div className="whitespace-pre-wrap">{data?.question || content}</div>
    </div>
  );
}

/** Renders one tool's result by name; each shape has its own small view
 *  component above so this stays a plain lookup. */
export function ToolResultBlock({ name, content }: { name: string, content: string }) {
  try {
    const data = JSON.parse(content);
    switch (name) {
      case 'bash': return <BashResultView data={data} />;
      case 'read': return <ReadResultView data={data} />;
      case 'web_search': return <WebSearchResultView data={data} />;
      case 'web_fetch': return <WebFetchResultView data={data} />;
      case 'write': {
        const label = `Wrote ${typeof data.bytes === 'number' ? `${data.bytes} bytes` : 'file'}${data.created ? ' (new file)' : ''}.`;
        return <FileMutationResultView data={data} label={label} />;
      }
      case 'edit':
      case 'apply_patch': {
        const label = `Applied edit (${typeof data.replacements === 'number' ? `${data.replacements} replacement${data.replacements === 1 ? '' : 's'}` : 'done'}).`;
        return <FileMutationResultView data={data} label={label} />;
      }
      case 'grep':
      case 'glob':
      case 'git_branch':
      case 'bash_poll':
        return <RawJsonResultView data={data} />;
      case 'ask_user':
        return <AskUserResultView data={data} content={content} />;
      default:
        break;
    }
  } catch {
    // fallback
  }
  return <div className="text-sm whitespace-pre-wrap">{content}</div>;
}

/** Collapsed-by-default harness report (Scout / Verify / Critic). These are
 *  model-written markdown documents injected into the transcript — they get a
 *  proper source label and render as markdown when expanded, instead of
 *  showing up as a plain "user" wall of text. */
export function ReportBlock({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(!message.collapsed);
  const preview = (message.content.replace(/^#+\s*/, '').split('\n')[0] || '').slice(0, 90);
  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-line bg-panel">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={13} className={`shrink-0 text-faint transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="font-semibold text-xs text-faint">{message.displayName}</span>
        {!open && preview && <span className="truncate text-[11.5px] text-faint">{preview}</span>}
        <span className="ml-auto shrink-0 text-[11px] text-faint">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && message.content && (
        <div className="markdown border-t border-line px-3 py-2 text-[13.5px] leading-relaxed">
          <Suspense fallback={null}>
            <Markdown>{message.content}</Markdown>
          </Suspense>
        </div>
      )}
    </div>
  );
}

export function TrajectoryBlock({ items }: { items: ChatMessage[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-line bg-panel2 overflow-hidden mb-4">
      <button
        className="w-full p-2 flex items-center justify-between text-[11.5px] font-medium hover:bg-inset"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2 text-mute">
          <BrainCircuit size={13} />
          <span>Agent thinking & working ({items.length} steps)</span>
        </div>
        <span className="text-faint">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="p-3 border-t border-line space-y-3 bg-panel">
          {items.map((m, i) => (
            <div key={i} className={cn("p-2 rounded border", m.role === 'tool' ? 'bg-inset border-transparent' : 'bg-panel border-accent/20')}>
              <div className="font-semibold text-[10px] text-faint mb-1 uppercase tracking-wider">{m.role === 'assistant' ? 'Garrulous' : m.role} {m.name ? `· ${m.name}` : ''}</div>
              {m.reasoning && (
                <div className="break-words text-[11px] text-mute border-l-2 border-accent/50 pl-2 mb-2 italic whitespace-pre-wrap">{m.reasoning}</div>
              )}
              {m.content && m.role !== 'tool' && (
                m.role === 'assistant'
                  ? <div className="markdown text-[12px] leading-relaxed"><Suspense fallback={null}><Markdown>{m.content}</Markdown></Suspense></div>
                  : <div className="break-words text-[12px] whitespace-pre-wrap">{m.content}</div>
              )}
              {m.role === 'tool' && m.content && (
                 <ToolResultBlock name={m.name!} content={m.content} />
              )}
              {m.tool_calls && (
                <div className="mt-2 space-y-1">
                  {m.tool_calls.map((tc, j) => (
                    <div key={j} className="text-[11px] font-mono text-accent bg-accent/10 p-1.5 rounded flex items-start gap-1">
                      <span className="mt-0.5">⚡</span>
                      <span className="break-all">{tc.name}({tc.arguments})</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
      </div>
      )}
    </div>
  );
}
