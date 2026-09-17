import { BookmarkPlus, Save } from 'lucide-react';
import { Button, SectionCard, TextField } from '../../components/ui';
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
        {saved.map((s) => {
          const p = s.profile;
          const bits = [
            p.spec ? `${p.spec} ${p.draftTokens ?? ''}`.trim() : 'no spec',
            p.maxContext ? `ctx ${p.maxContext}` : 'ctx default',
            p.kvDtype ? `KV ${p.kvDtype}` : '',
            p.maxConcurrency ? `C=${p.maxConcurrency}` : '',
            p.vision ? 'vision' : '',
          ].filter(Boolean);
          return (
            <div key={s.name} className="flex items-center gap-2 rounded-lg border border-line bg-inset px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[12px] text-ink">{s.name}</p>
                <p className="truncate text-[11px] text-faint">{bits.join(' · ')}</p>
              </div>
              <Button size="sm" variant="primary" onClick={() => { setProfile({ ...BLANK_PROFILE, ...s.profile, port: profile.port }); setAppliedPresetId(null); setNotice({ tone: 'ok', text: `loaded “${s.name}” — review the generated command, then stop + start the engine` }); }}>
                load
              </Button>
              <button className="text-faint hover:text-danger" title="Delete profile" onClick={() => setSaved((x) => x.filter((y) => y.name !== s.name))}>
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}
