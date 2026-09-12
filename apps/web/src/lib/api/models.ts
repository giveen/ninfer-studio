// Model artifact management: kicking off a Hugging Face download. Progress
// for an in-flight download is read back via the combined status payload
// (see api/config.ts's getStatus/useStatus), not a dedicated poll endpoint.

import { postJSON } from './core';

export function downloadModel(repo: string, file: string, localDir?: string) {
  return postJSON<{ ok: boolean; id?: string; message?: string }>('/api/models/download', {
    repo,
    file,
    localDir,
  });
}
