import { useState } from 'react';
import { BookmarkPlus, ChevronDown, Save } from 'lucide-react';
import { Button, SectionCard, TextField, cn } from '../../components/ui';
import { BLANK_PROFILE } from '../../lib/presets';
import type { EngineProfile, SavedProfile } from '../../lib/types';
import type { EngineNotice } from '../EngineScreen';

interface ProfilesTabProps {
  profile: EngineProfile;
  setProfile: (p: EngineProfile) => void;
  setAppliedPresetId: (id: string | null) => void;
  setNotice: (n: EngineNotice | null) => void;
  saveName: string;
  setSaveName: (v: string) => void;
  saveCurrent: () => void;
  saved: SavedProfile[];
  setSaved: (fn: (s: SavedProfile[]) => SavedProfile[]) => void;
}

function SavedProfileCard({
  savedProfile,
  onLoad,
  onDelete,
}: {
  savedProfile: SavedProfile;
  onLoad: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const p = savedProfile.profile;

  const bits = [
    p.spec ? `${p.spec} ${p.draftTokens ?? ''}`.trim() : 'no spec',
    p.maxContext ? `ctx ${p.maxContext}` : 'ctx default',
    p.kvDtype ? `KV ${p.kvDtype}` : '',
    p.maxConcurrency ? `C=${p.maxConcurrency}` : '',
    p.vision ? 'vision' : '',
  ].filter(Boolean);

  const activeEntries = Object.entries(p).filter(
    ([_, v]) => v !== undefined && v !== null && v !== '',
  );

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-inset transition-colors hover:border-accent/40">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded p-1 text-faint hover:text-ink transition-colors"
          title={expanded ? 'Hide settings' : 'Show settings'}
        >
          <ChevronDown size={14} className={cn('transition-transform', expanded && 'rotate-180')} />
        </button>
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
          <p className="truncate font-mono text-[12px] text-ink">{savedProfile.name}</p>
          <p className="truncate text-[11px] text-faint">{bits.join(' · ')}</p>
        </div>
        <Button size="sm" variant="primary" onClick={onLoad}>
          load
        </Button>
        <button className="p-1 text-faint hover:text-danger" title="Delete profile" onClick={onDelete}>
          ✕
        </button>
      </div>

      {expanded && (
        <div className="border-t border-line bg-panel2 px-3 py-2.5 text-[11.5px]">
          <p className="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-faint">
            Settings configured in this profile ({activeEntries.length})
          </p>
          {activeEntries.length === 0 ? (
            <p className="text-[11px] text-faint">No explicit settings set (uses defaults).</p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 md:grid-cols-4">
              {activeEntries.map(([key, val]) => (
                <div key={key} className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-[10px] text-faint">{key}</span>
                  <span className="truncate font-mono text-[11px] font-medium text-ink">
                    {String(val)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ProfilesTab({ profile, setProfile, setAppliedPresetId, setNotice, saveName, setSaveName, saveCurrent, saved, setSaved }: ProfilesTabProps) {
  return (
    <SectionCard title="Profiles" description="Saved profiles map 1:1 to ninfer-serve flags and persist with your Studio profile. 'load' fills the form — then stop + start." icon={<BookmarkPlus size={15} />} collapsible>
      <div className="flex items-center gap-2">
        <TextField value={saveName} onChange={setSaveName} placeholder="profile name" className="flex-1" />
        <Button size="sm" variant="primary" onClick={saveCurrent}>
          <Save size={13} /> save current
        </Button>
      </div>
      <div className="mt-3 space-y-1.5">
        {saved.length === 0 && <p className="text-[12px] text-faint">Nothing saved yet.</p>}
        {saved.map((s) => (
          <SavedProfileCard
            key={s.name}
            savedProfile={s}
            onLoad={() => {
              setProfile({ ...BLANK_PROFILE, ...s.profile, port: profile.port });
              setAppliedPresetId(null);
              setNotice({ tone: 'ok', text: `loaded “${s.name}” — review the generated command, then stop + start the engine` });
            }}
            onDelete={() => setSaved((x) => x.filter((y) => y.name !== s.name))}
          />
        ))}
      </div>
    </SectionCard>
  );
}
