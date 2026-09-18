import React, { useEffect, useRef, useState } from 'react';
import { Palette, Check, Copy, RotateCcw, Sparkles, Sun, Moon, Laptop, Code, Type, Trash2, Download, Upload, Save } from 'lucide-react';
import { Button, SectionCard, cn } from '../../components/ui';
import {
  FONT_MONO_PRESETS,
  FONT_SANS_PRESETS,
  PRESET_THEMES,
  applyFontFamily,
  applyPresetTheme,
  applyUIScale,
  deleteUserThemePreset,
  exportThemeCSS,
  exportThemeJSON,
  getPresetVariables,
  getStoredCustomVars,
  getStoredFontMono,
  getStoredFontSans,
  getStoredPreset,
  getStoredTheme,
  getStoredUIScale,
  getUserThemePresets,
  parseAndValidateThemeJSON,
  saveUserThemePreset,
  type ThemeMode,
  type ThemePresetId,
  type ThemeVariables,
  type UserThemePreset,
} from '../../lib/theme';

export function ThemesTab() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredTheme());
  const [activePreset, setActivePreset] = useState<ThemePresetId>(() => getStoredPreset());
  const [userPresets, setUserPresets] = useState<UserThemePreset[]>(() => getUserThemePresets());
  const [sansFont, setSansFont] = useState<string>(() => getStoredFontSans());
  const [monoFont, setMonoFont] = useState<string>(() => getStoredFontMono());
  const [uiScale, setUiScale] = useState<string>(() => getStoredUIScale());
  const [savePresetName, setSavePresetName] = useState<string>('');
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [customVars, setCustomVars] = useState<ThemeVariables>(() => {
    const stored = getStoredCustomVars();
    if (stored) return stored;
    const initialPreset = getStoredPreset();
    const vars = getPresetVariables(initialPreset, getStoredTheme());
    if (vars) return vars;
    return PRESET_THEMES['midnight-lime'].darkVariables;
  });
  const [copiedCSS, setCopiedCSS] = useState(false);
  const [copiedJSON, setCopiedJSON] = useState(false);

  // Initialize theme state on mount
  useEffect(() => {
    if (activePreset === 'custom') {
      applyPresetTheme('custom', customVars, themeMode);
    } else {
      applyPresetTheme(activePreset, null, themeMode);
      const vars = getPresetVariables(activePreset, themeMode);
      if (vars) setCustomVars(vars);
    }
    applyFontFamily(sansFont, monoFont);
    applyUIScale(uiScale);
  }, []);

  const handleSelectMode = (mode: ThemeMode) => {
    setThemeMode(mode);
    if (activePreset === 'custom') {
      applyPresetTheme('custom', customVars, mode);
    } else {
      applyPresetTheme(activePreset, null, mode);
      const vars = getPresetVariables(activePreset, mode);
      if (vars) setCustomVars(vars);
    }
  };

  const handleSelectPreset = (presetId: ThemePresetId) => {
    setActivePreset(presetId);
    if (presetId === 'custom') {
      applyPresetTheme('custom', customVars, themeMode);
    } else {
      const vars = getPresetVariables(presetId, themeMode);
      if (vars) setCustomVars(vars);
      applyPresetTheme(presetId, null, themeMode);
    }
  };

  const handleSavePreset = (e: React.FormEvent) => {
    e.preventDefault();
    if (!savePresetName.trim()) return;
    const newPreset = saveUserThemePreset(savePresetName, customVars, customVars);
    const updated = getUserThemePresets();
    setUserPresets(updated);
    setSavePresetName('');
    setActivePreset(newPreset.id);
    applyPresetTheme(newPreset.id, null, themeMode);
  };

  const handleDeleteUserPreset = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteUserThemePreset(id);
    const updated = getUserThemePresets();
    setUserPresets(updated);
    if (activePreset === id) {
      setActivePreset('midnight-lime');
      applyPresetTheme('midnight-lime', null, themeMode);
      const vars = getPresetVariables('midnight-lime', themeMode);
      if (vars) setCustomVars(vars);
    }
  };

  const handleImportClick = () => {
    setImportError(null);
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = parseAndValidateThemeJSON(text);
        const newPreset = saveUserThemePreset(parsed.name, parsed.darkVariables, parsed.lightVariables);
        const updated = getUserThemePresets();
        setUserPresets(updated);
        setActivePreset(newPreset.id);
        const vars = getPresetVariables(newPreset.id, themeMode);
        if (vars) setCustomVars(vars);
        applyPresetTheme(newPreset.id, null, themeMode);
        setImportError(null);
      } catch (err: any) {
        setImportError(err.message || 'Failed to import theme JSON file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleExportJSONFile = () => {
    const presetName =
      activePreset === 'custom'
        ? 'Custom Theme'
        : userPresets.find((p) => p.id === activePreset)?.name ||
          PRESET_THEMES[activePreset as keyof typeof PRESET_THEMES]?.name ||
          'Custom Theme';

    const presetData = {
      name: presetName,
      darkVariables: customVars,
      lightVariables: customVars,
    };
    const jsonStr = exportThemeJSON(presetData);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${presetName.toLowerCase().replace(/\s+/g, '-')}-theme.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSelectSansFont = (val: string) => {
    setSansFont(val);
    applyFontFamily(val, monoFont);
  };

  const handleSelectMonoFont = (val: string) => {
    setMonoFont(val);
    applyFontFamily(sansFont, val);
  };

  const handleSelectUIScale = (val: string) => {
    setUiScale(val);
    applyUIScale(val);
  };

  const handleCustomVarChange = (key: keyof ThemeVariables, value: string) => {
    const updated = { ...customVars, [key]: value };
    setCustomVars(updated);
    setActivePreset('custom');
    applyPresetTheme('custom', updated, themeMode);
  };

  const handleReset = () => {
    setActivePreset('midnight-lime');
    setThemeMode('dark');
    const defaultVars = PRESET_THEMES['midnight-lime'].darkVariables;
    setCustomVars(defaultVars);
    applyPresetTheme('midnight-lime', null, 'dark');
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

  const currentVars =
    activePreset === 'custom' ? customVars : getPresetVariables(activePreset, themeMode) ?? customVars;

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

      {/* Typography & Fonts Card */}
      <SectionCard
        title="Typography & Fonts"
        icon={<Type size={15} />}
        description="Customize interface typography and code block monospaced font families."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* UI Scale Selector */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel2/40 p-3">
            <label htmlFor="select-ui-scale" className="font-semibold text-[12.5px] text-ink">
              Interface Text Scale
            </label>
            <p className="text-[11px] text-faint">Adjust base text size for comfortable viewing.</p>
            <select
              id="select-ui-scale"
              value={uiScale}
              onChange={(e) => handleSelectUIScale(e.target.value)}
              className="mt-1 w-full rounded border border-line bg-inset px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent/50"
            >
              <option value="12.5px">Compact (90%)</option>
              <option value="14px">Normal (100%)</option>
              <option value="15.5px">Large (110%)</option>
            </select>
          </div>

          {/* UI Sans Font Selector */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel2/40 p-3">
            <label htmlFor="select-sans-font" className="font-semibold text-[12.5px] text-ink">
              Interface Font (Sans-Serif)
            </label>
            <p className="text-[11px] text-faint">Applied across navigation, buttons, and conversation chat bubbles.</p>
            <select
              id="select-sans-font"
              value={sansFont}
              onChange={(e) => handleSelectSansFont(e.target.value)}
              className="mt-1 w-full rounded border border-line bg-inset px-2.5 py-1.5 font-sans text-[12px] text-ink outline-none focus:border-accent/50"
            >
              {FONT_SANS_PRESETS.map((f) => (
                <option key={f.id} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          {/* Code Mono Font Selector */}
          <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel2/40 p-3">
            <label htmlFor="select-mono-font" className="font-semibold text-[12.5px] text-ink">
              Code & Editor Font (Monospace)
            </label>
            <p className="text-[11px] text-faint">Applied to code snippets, CodeMirror editor, and terminal outputs.</p>
            <select
              id="select-mono-font"
              value={monoFont}
              onChange={(e) => handleSelectMonoFont(e.target.value)}
              className="mt-1 w-full rounded border border-line bg-inset px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent/50"
            >
              {FONT_MONO_PRESETS.map((f) => (
                <option key={f.id} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </SectionCard>

      {/* Preset Themes Grid */}
      <SectionCard
        title="Theme Presets"
        icon={<Palette size={15} />}
        description="Choose a built-in preset, load your saved custom themes, or import theme files."
        actions={
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="hidden"
            />
            <Button variant="ghost" size="sm" onClick={handleImportClick}>
              <Upload size={13} /> Import JSON
            </Button>
          </div>
        }
      >
        {importError && (
          <div className="mb-3 rounded-md border border-danger/30 bg-danger/10 p-2.5 text-[12px] text-danger">
            {importError}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          {/* Built-in themes */}
          {(Object.keys(PRESET_THEMES) as Array<keyof typeof PRESET_THEMES>).map((presetId) => {
            const preset = PRESET_THEMES[presetId];
            const isSelected = activePreset === presetId;
            const vars = getPresetVariables(presetId, themeMode) ?? preset.darkVariables;

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
                  {isSelected && <Check size={14} className="text-accent" />}
                </div>

                {/* Color swatches preview */}
                <div className="mt-3 flex items-center gap-1.5">
                  <div
                    className="h-4 w-4 rounded-full border border-line"
                    style={{ backgroundColor: vars.bg }}
                    title="Background"
                  />
                  <div
                    className="h-4 w-4 rounded-full border border-line"
                    style={{ backgroundColor: vars.panel }}
                    title="Panel"
                  />
                  <div
                    className="h-4 w-4 rounded-full border border-line"
                    style={{ backgroundColor: vars.panel2 }}
                    title="Active Surface"
                  />
                  <div
                    className="h-4 w-4 rounded-full border border-line"
                    style={{ backgroundColor: vars.accent }}
                    title="Accent Glow"
                  />
                  <div
                    className="h-4 w-4 rounded-full border border-line"
                    style={{ backgroundColor: vars.ink }}
                    title="Text Ink"
                  />
                </div>
              </button>
            );
          })}

          {/* User saved presets */}
          {userPresets.map((uPreset) => {
            const isSelected = activePreset === uPreset.id;
            const vars = getPresetVariables(uPreset.id, themeMode) ?? uPreset.darkVariables;

            return (
              <div
                key={uPreset.id}
                onClick={() => handleSelectPreset(uPreset.id)}
                className={cn(
                  'group relative flex flex-col justify-between rounded-lg border p-3.5 text-left transition-all cursor-pointer',
                  isSelected
                    ? 'border-accent bg-accent/10 shadow-sm'
                    : 'border-line bg-panel2/40 hover:border-line2 hover:bg-panel2'
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="font-semibold text-[13px] text-ink truncate">{uPreset.name}</span>
                    <span className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[9.5px] font-medium text-accent">
                      User
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {isSelected && <Check size={14} className="text-accent" />}
                    <button
                      type="button"
                      onClick={(e) => handleDeleteUserPreset(e, uPreset.id)}
                      title="Delete Theme Preset"
                      className="rounded p-1 text-faint opacity-0 transition-opacity hover:bg-panel hover:text-danger group-hover:opacity-100"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {/* Color swatches preview */}
                <div className="mt-3 flex items-center gap-1.5">
                  <div
                    className="h-4 w-4 rounded-full border border-line"
                    style={{ backgroundColor: vars.bg }}
                    title="Background"
                  />
                  <div
                    className="h-4 w-4 rounded-full border border-line"
                    style={{ backgroundColor: vars.panel }}
                    title="Panel"
                  />
                  <div
                    className="h-4 w-4 rounded-full border border-line"
                    style={{ backgroundColor: vars.panel2 }}
                    title="Active Surface"
                  />
                  <div
                    className="h-4 w-4 rounded-full border border-line"
                    style={{ backgroundColor: vars.accent }}
                    title="Accent Glow"
                  />
                  <div
                    className="h-4 w-4 rounded-full border border-line"
                    style={{ backgroundColor: vars.ink }}
                    title="Text Ink"
                  />
                </div>
              </div>
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
            <div className="flex items-center justify-between border-b border-line pb-1">
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
                { key: 'line', label: 'Border Subdued', varName: '--color-line' },
                { key: 'line2', label: 'Border Distinct', varName: '--color-line2' },
              ].map((colorItem) => {
                const k = colorItem.key as keyof ThemeVariables;
                const val = currentVars[k] ?? '';

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

            {/* Save Custom Theme Form */}
            <form onSubmit={handleSavePreset} className="flex items-center gap-2 border-t border-line pt-3">
              <input
                type="text"
                placeholder="Save current theme as..."
                value={savePresetName}
                onChange={(e) => setSavePresetName(e.target.value)}
                className="w-full rounded border border-line bg-inset px-2.5 py-1 text-[12px] text-ink outline-none focus:border-accent/50"
              />
              <Button variant="primary" size="sm" type="submit" disabled={!savePresetName.trim()} className="shrink-0">
                <Save size={13} /> Save Preset
              </Button>
            </form>

            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={handleCopyCSS}>
                {copiedCSS ? <Check size={13} className="text-ok" /> : <Code size={13} />}
                {copiedCSS ? 'Copied CSS!' : 'Export CSS'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCopyJSON}>
                {copiedJSON ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
                {copiedJSON ? 'Copied JSON!' : 'Copy JSON'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleExportJSONFile}>
                <Download size={13} /> Export .json
              </Button>
              <Button variant="ghost" size="sm" onClick={handleReset} className="ml-auto text-faint hover:text-danger">
                <RotateCcw size={13} /> Reset Theme
              </Button>
            </div>
          </div>

          {/* Live Preview column */}
          <div className="flex flex-col gap-3 lg:col-span-5">
            <span className="border-b border-line pb-1 font-medium text-[12px] text-ink uppercase tracking-wider">
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
                  className="max-w-[85%] rounded-lg border border-line p-2.5 text-[12px] shadow-sm"
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
