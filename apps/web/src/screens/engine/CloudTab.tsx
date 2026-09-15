import { useEffect, useState } from 'react';
import { Cloud, RefreshCw } from 'lucide-react';
import { Button, Field, SectionCard, SelectField, TextField, Toggle } from '../../components/ui';
import type { AppSettings } from '../../lib/types';
import { fetchCloudModels } from '../../lib/api';

interface CloudTabProps {
  settings: AppSettings | null;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

const COMMON_OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1',
  'o1-mini',
  'o1-preview',
  'o3-mini',
];

export function CloudTab({ settings, onUpdate }: CloudTabProps) {
  const [apiDraft, setApiDraft] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');

  useEffect(() => {
    if (settings?.cloudProviderDefaultModel) {
      setSelectedModel(settings.cloudProviderDefaultModel);
    }
  }, [settings?.cloudProviderDefaultModel]);

  if (!settings) return null;

  const handleApiKeyChange = (v: string) => {
    setApiDraft(v);
    onUpdate({ cloudProviderApiKey: v || undefined });
  };

  const handleDetectModels = async () => {
    setLoadingModels(true);
    setFetchError(null);
    try {
      const baseUrl = settings.cloudProviderBaseUrl || 'https://api.openai.com/v1';
      const key = apiDraft.trim() || settings.cloudProviderApiKey || '';
      const detected = await fetchCloudModels(baseUrl, key);
      setModels(detected);
      if (detected.length > 0) {
        const defaultPick = selectedModel && detected.includes(selectedModel)
          ? selectedModel
          : detected.includes('gpt-4o-mini')
          ? 'gpt-4o-mini'
          : detected.includes('gpt-4o')
          ? 'gpt-4o'
          : detected[0];
        setSelectedModel(defaultPick);
        onUpdate({ cloudProviderDefaultModel: defaultPick });
      }
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingModels(false);
    }
  };

  const currentDefault = selectedModel || settings.cloudProviderDefaultModel || 'gpt-4o-mini';
  const combinedList = Array.from(new Set([...COMMON_OPENAI_MODELS, ...models, ...(currentDefault ? [currentDefault] : [])]));
  const modelOptions = combinedList.map((m) => ({
    value: m,
    label: m,
  }));

  return (
    <div className="space-y-4">
      <SectionCard
        title="Cloud AI Providers"
        description="Enable this to use external cloud AI providers in the Chat and Code harnesses instead of local models."
        icon={<Cloud size={15} />}
      >
        <div className="space-y-5">
          <Toggle
            checked={!!settings.cloudProviderEnabled}
            onChange={(v) => onUpdate({ cloudProviderEnabled: v })}
            label="Enable custom cloud provider"
            hint="When enabled, you can switch between ninfer and cloud providers in the Chat and Code parameter settings."
          />

          {settings.cloudProviderEnabled && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
                <Field label="Base URL" hint="The API endpoint URL for the cloud provider (e.g., https://api.openai.com/v1).">
                  <TextField
                    value={settings.cloudProviderBaseUrl || ''}
                    onChange={(v) => onUpdate({ cloudProviderBaseUrl: v || undefined })}
                    placeholder="https://api.openai.com/v1"
                  />
                </Field>
                <Field label="API Key" hint="Your API key for the cloud provider.">
                  <div className="flex items-center gap-2">
                    <TextField
                      value={apiDraft}
                      onChange={handleApiKeyChange}
                      placeholder={settings.cloudProviderApiKey ? '******** (saved)' : 'sk-...'}
                      type="password"
                      spellCheck={false}
                    />
                    {settings.cloudProviderApiKey && !apiDraft && (
                      <Button size="sm" variant="ghost" onClick={() => onUpdate({ cloudProviderApiKey: '' })}>
                        clear
                      </Button>
                    )}
                  </div>
                </Field>
              </div>

              <div className="rounded-lg border border-line bg-panel p-3.5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-[13px] font-medium text-ink">Default Cloud Model</h4>
                    <p className="text-[11.5px] text-faint">
                      Auto-detect models from your provider or select from the dropdown list to set your default cloud model.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleDetectModels}
                    disabled={loadingModels}
                    title="Probe the provider's /v1/models endpoint to auto-detect available model names"
                  >
                    <RefreshCw size={13} className={loadingModels ? 'animate-spin' : ''} />
                    {loadingModels ? 'Detecting…' : 'Auto-detect models'}
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-[200px]">
                    <SelectField
                      value={currentDefault}
                      onChange={(v) => {
                        setSelectedModel(v);
                        onUpdate({ cloudProviderDefaultModel: v });
                      }}
                      options={modelOptions}
                    />
                  </div>
                  <div className="w-56">
                    <TextField
                      value={selectedModel}
                      onChange={(v) => {
                        setSelectedModel(v);
                        onUpdate({ cloudProviderDefaultModel: v });
                      }}
                      placeholder="Or type custom model..."
                      className="text-[12px]"
                    />
                  </div>
                </div>

                {fetchError && <p className="text-[11.5px] text-danger">{fetchError}</p>}
                {models.length > 0 && (
                  <p className="text-[11px] text-ok">
                    Detected {models.length} model{models.length === 1 ? '' : 's'} from provider.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
