import { useState } from 'react';
import { Cloud } from 'lucide-react';
import { Button, Field, SectionCard, TextField, Toggle } from '../../components/ui';
import type { AppSettings } from '../../lib/types';

interface CloudTabProps {
  settings: AppSettings | null;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

export function CloudTab({ settings, onUpdate }: CloudTabProps) {
  const [apiDraft, setApiDraft] = useState('');

  if (!settings) return null;

  const handleApiKeyChange = (v: string) => {
    setApiDraft(v);
    onUpdate({ cloudProviderApiKey: v || undefined });
  };

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
          )}
        </div>
      </SectionCard>
    </div>
  );
}
