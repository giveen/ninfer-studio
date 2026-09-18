// Model artifact management & async operations (download, upgrade, convert).
// Progress for in-flight jobs is read back via the combined status payload
// (see api/config.ts's getStatus/useStatus), not a dedicated poll endpoint.

import { postJSON } from './core';

/** Kick off a Hugging Face model download.
 *  Note: The server spawns a background tokio job and returns an id immediately,
 *  so postJSON's default 10s timeout is safe. */
export function downloadModel(repo: string, file: string, localDir?: string) {
  return postJSON<{ ok: boolean; id?: string; message?: string }>('/api/models/download', {
    repo,
    file,
    localDir,
  });
}

/** Kick off a model upgrade script.
 *  Note: The server spawns the upgrade script asynchronously and returns {ok: true}
 *  immediately, so postJSON's default 10s timeout is safe. */
export function upgradeModel(file: string) {
  return postJSON<{ ok: boolean; message?: string }>('/api/models/upgrade', {
    file,
  });
}

/** Kick off a GGUF/Ninfer model conversion job.
 *  Note: The server spawns a background tokio job and returns an id immediately,
 *  so postJSON's default 10s timeout is safe. */
export function convertModel(modelPath: string, recipe: string, name: string, outName: string, extraArgs: string) {
  return postJSON<{ ok: boolean; id?: string; message?: string }>('/api/models/convert', {
    modelPath,
    recipe,
    name,
    outName,
    extraArgs,
  });
}
