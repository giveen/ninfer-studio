import type { MouseEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';

/** Hand a link off to the OS default browser when running inside the Tauri
 *  desktop shell — a plain `<a target="_blank">` click is otherwise
 *  silently swallowed by the webview (no window ever opens). Outside Tauri
 *  (plain browser against the dev control plane) this is a no-op and the native
 *  anchor behavior handles it. Pass as an `<a>`'s `onClick`. */
export function openExternalLink(e: MouseEvent<HTMLAnchorElement>, href: string | undefined) {
  if (!href || !isTauri()) return;
  e.preventDefault();
  import('@tauri-apps/plugin-opener')
    .then(({ openUrl }) => openUrl(href))
    .catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
}
