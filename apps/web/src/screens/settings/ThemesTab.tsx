import { useEffect, useState } from 'react';
import { Palette, Check, Copy, RotateCcw, Sparkles, Sun, Moon, Laptop, Code } from 'lucide-react';
import { Button, SectionCard, cn } from '../../components/ui';
import {
  PRESET_THEMES,
  applyPresetTheme,
  applyTheme,
  exportThemeCSS,
  getStoredCustomVars,
  getStoredPreset,
  getStoredTheme,
  type ThemeMode,
  type ThemePresetId,
  type ThemeVariables,
} from '../../lib/theme';

export function ThemesTab() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredTheme());
  const [activePreset, setActivePreset] = useState<ThemePresetId>(() => getStoredPreset());
  const [customVars, setCustomVars] = useState<ThemeVariables>(() => {
    const stored = getStoredCustomVars();
    if (stored) return stored;
    return { ...PRESET_THEMES['midnight-lime'].variables };
  });
  const [copiedCSS, setCopiedCSS] = useState(false);
  const [copiedJSON, setCopiedJSON] = useState(false);

  // Initialize theme state on mount
  useEffect(() => {
    if (activePreset === 'custom') {
      applyPresetTheme('custom', customVars);
    } else if (activePreset in PRESET_THEMES) {
      applyPresetTheme(activePreset);
    }
  }, []);

  const handleSelectMode = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyTheme(mode);
  };

  const handleSelectPreset = (presetId: ThemePresetId) => {
    setActivePreset(presetId);
    if (presetId in PRESET_THEMES) {
      const preset = PRESET_THEMES[presetId as keyof typeof PRESET_THEMES];
      setCustomVars({ ...preset.variables });
      applyPresetTheme(presetId);
    } else {
      applyPresetTheme('custom', customVars);
    }
  };

  const handleCustomVarChange = (key: keyof ThemeVariables, value: string) => {
    const updated = { ...customVars, [key]: value };
    setCustomVars(updated);
    setActivePreset('custom');
    applyPresetTheme('custom', updated);
  };

  const handleReset = () => {
    const defaultVars = { ...PRESET_THEMES['midnight-lime'].variables };
    setCustomVars(defaultVars);
    setActivePreset('midnight-lime');
    handleSelectMode('dark');
    applyPresetTheme('midnight-lime');
  };

  const handleCopyCSS = () => {
    const css = exportThemeCSS(customVars);
    navigator.clipboard.writeText(css);
    setCopiedCSS(true);
    setTimeout(() => setCopiedCSS(false), 2000);
  };

  const handleCopyJSON = () => {
    const json = JSON.stringify(customVars, null, 2);
    navigator.clipboard.writeText(json);
    setCopiedJSON(true);
    setTimeout(() => setCopiedJSON(false), 2000);
  };

  const currentVars = activePreset === 'custom' ? customVars : PRESET_THEMES[activePreset as keyof typeof PRESET_THEMES]?.variables ?? customVars;

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-5 py-4">
      {/* Theme Mode Card */}
      <SectionCard
        title="Appearance Mode"
        icon={<Sun size={15} />}
        description="Select display mode or automatically synchronize with operating system appearance settings."
      >
        <div className="grid grid-cols-3 gap-3">
          {[
            { id: 'dark', label: 'Dark Mode', icon: Moon, desc: 'Optimized for low-light' },
            { id: 'light', label: 'Light Mode', icon: Sun, desc: 'Crisp & high-contrast' },
            { id: 'system', label: 'System OS', icon: Laptop, desc: 'Match desktop preference' },
          ].map((item) => {
            const Icon = item.icon;
            const isSelected = themeMode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectMode(item.id as ThemeMode)}
                className={cn(
                  'flex items-center gap-3 rounded-lg border p-3 text-left transition-all',
                  isSelected
                    ? 'border-accent bg-accent/10 text-ink shadow-sm'
                    : 'border-line bg-panel2/50 text-mute hover:border-line2 hover:text-ink hover:bg-panel2'
                )}
              >
                <div className={cn('rounded-md p-2', isSelected ? 'bg-accent/20 text-accent' : 'bg-inset text-mute')}>
                  <Icon size={16} />
                </div>
                <div>
                  <div className="flex items-center gap-1.5 font-medium text-[13px] text-ink">
                    {item.label}
                    {isSelected && <Check size={13} className="text-accent" />}
                  </div>
                  <div className="text-[11px] text-faint">{item.desc}</div>
                </div>
              </button>
            );
          })}
        </div>
      </SectionCard>

      {/* Preset Themes Grid */}
      <SectionCard
        title="Theme Presets"
        icon={<Palette size={15} />}
        description="Choose a curated color scheme preset or develop your own custom variables."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          {(Object.keys(PRESET_THEMES) as Array<keyof typeof PRESET_THEMES>).map((presetId) => {
            const preset = PRESET_THEMES[presetId];
            const isSelected = activePreset === presetId;
            return (
              <button
                key={presetId}
                type="button"
                onClick={() => handleSelectPreset(presetId)}
                className={cn(
                  'group relative flex flex-col justify-between rounded-lg border p-3.5 text-left transition-all',
                  isSelected
                    ? 'border-accent bg-accent/10 shadow-sm'
                    : 'border-line bg-panel2/40 hover:border-line2 hover:bg-panel2'
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[13px] text-ink">{preset.name}</span>
                  <div className="flex items-center gap-1">
                    <span className="rounded bg-inset px-1.5 py-0.5 font-mono text-[10px] text-mute uppercase">
                      {preset.mode}
                    </span>
                    {isSelected && <Check size={14} className="text-accent" />}
                  </div>
                </div>

                {/* Color swatches preview */}
                <div className="mt-3 flex items-center gap-1.5">
                  <div className="h-4 w-4 rounded-full border border-line" style={{ backgroundColor: preset.variables.bg }} title="Background" />
                  <div className="h-4 w-4 rounded-full border border-line" style={{ backgroundColor: preset.variables.panel }} title="Panel" />
                  <div className="h-4 w-4 rounded-full border border-line" style={{ backgroundColor: preset.variables.panel2 }} title="Active Surface" />
                  <div className="h-4 w-4 rounded-full border border-line" style={{ backgroundColor: preset.variables.accent }} title="Accent Glow" />
                  <div className="h-4 w-4 rounded-full border border-line" style={{ backgroundColor: preset.variables.ink }} title="Text Ink" />
                </div>
              </button>
            );
          })}
        </div>
      </SectionCard>

      {/* Live Preview & Color Variable Customizer */}
      <SectionCard
        title="Theme Developer & Live Preview"
        icon={<Sparkles size={15} />}
        description="Fine-tune CSS color tokens in real-time and preview how chat cards and UI elements render."
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Color pickers column */}
          <div className="space-y-3 lg:col-span-7">
            <div className="flex items-center justify-between pb-1 border-b border-line">
              <span className="font-medium text-[12px] text-ink uppercase tracking-wider">CSS Variables</span>
              {activePreset === 'custom' && (
                <span className="rounded bg-accent/20 px-2 py-0.5 text-[10px] font-medium text-accent">
                  Custom Theme Active
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {[
                { key: 'bg', label: 'Canvas Background', varName: '--color-bg' },
                { key: 'panel', label: 'Main Panel', varName: '--color-panel' },
                { key: 'panel2', label: 'Card / Active Surface', varName: '--color-panel2' },
                { key: 'inset', label: 'Code / Input Inset', varName: '--color-inset' },
                { key: 'ink', label: 'Primary Text', varName: '--color-ink' },
                { key: 'mute', label: 'Muted Text', varName: '--color-mute' },
                { key: 'accent', label: 'Primary Accent', varName: '--color-accent' },
                { key: 'accentHover', label: 'Accent Hover', varName: '--color-accent-hover' },
              ].map((colorItem) => {
                const k = colorItem.key as keyof ThemeVariables;
                const val = currentVars[k];
                return (
                  <div key={colorItem.key} className="flex flex-col gap-1 rounded-md border border-line bg-inset p-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-medium text-ink">{colorItem.label}</span>
                      <span className="font-mono text-faint">{colorItem.varName}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={val.startsWith('#') ? val : '#000000'}
                        onChange={(e) => handleCustomVarChange(k, e.target.value)}
                        className="h-6 w-7 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0"
                      />
                      <input
                        type="text"
                        value={val}
                        onChange={(e) => handleCustomVarChange(k, e.target.value)}
                        className="w-full rounded border border-line bg-panel px-2 py-0.5 font-mono text-[11px] text-ink outline-none focus:border-accent/50"
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={handleCopyCSS}>
                {copiedCSS ? <Check size={13} className="text-ok" /> : <Code size={13} />}
                {copiedCSS ? 'Copied CSS!' : 'Export CSS'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCopyJSON}>
                {copiedJSON ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
                {copiedJSON ? 'Copied JSON!' : 'Copy JSON'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleReset} className="ml-auto text-faint hover:text-danger">
                <RotateCcw size={13} /> Reset Theme
              </Button>
            </div>
          </div>

          {/* Live Preview column */}
          <div className="flex flex-col gap-3 lg:col-span-5">
            <span className="font-medium text-[12px] text-ink uppercase tracking-wider pb-1 border-b border-line">
              Live Surface Preview
            </span>

            {/* Preview Box container with variables applied */}
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 shadow-lg">
              {/* Fake Topbar */}
              <div className="flex items-center justify-between border-b border-line pb-2">
                <div className="flex items-center gap-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-accent" />
                  <span className="font-semibold text-[12px] text-ink">NINFER STUDIO</span>
                </div>
                <button
                  type="button"
                  className="rounded-md bg-accent px-2.5 py-1 font-medium text-[11px] text-panel shadow-sm hover:brightness-105"
                  style={{ backgroundColor: currentVars.accent, color: currentVars.bg }}
                >
                  + New Chat
                </button>
              </div>

              {/* User Message Bubble */}
              <div className="flex justify-end">
                <div
                  className="max-w-[85%] rounded-lg p-2.5 text-[12px] shadow-sm border border-line"
                  style={{ backgroundColor: currentVars.panel2, color: currentVars.ink }}
                >
                  Can you optimize this sorting function in Python?
                </div>
              </div>

              {/* Ninfer Assistant Message Card */}
              <div
                className="space-y-2 rounded-lg border border-line p-3 text-[12px]"
                style={{ backgroundColor: currentVars.panel2 }}
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium text-accent" style={{ color: currentVars.accent }}>
                    NINFER qwen3.8-27b
                  </span>
                  <span className="rounded bg-inset px-1.5 py-0.5 font-mono text-[10px]" style={{ color: currentVars.mute }}>
                    38 t/s · 0.8s
                  </span>
                </div>

                <p style={{ color: currentVars.ink }}>Here is the optimized implementation using Timsort:</p>

                {/* Code Block */}
                <div
                  className="rounded border border-line p-2.5 font-mono text-[11px]"
                  style={{ backgroundColor: currentVars.inset, color: currentVars.ink }}
                >
                  <span style={{ color: currentVars.accent }}>def</span> quick_sort(arr):<br />
                  &nbsp;&nbsp;<span style={{ color: currentVars.mute }}># Built-in sorted uses C-optimized Timsort</span><br />
                  &nbsp;&nbsp;<span style={{ color: currentVars.accent }}>return</span> sorted(arr)
                </div>
              </div>
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
