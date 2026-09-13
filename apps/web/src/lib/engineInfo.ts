// Small derived-from-status helpers shared by any screen that needs to know
// about the running engine's launch profile without re-fetching it — status
// is already live-polled and passed down as a prop everywhere this matters.

import type { StatusPayload } from './types';

/** The running engine's max-concurrency, from the profile it was actually
 *  launched with (not the current form) — fails closed to 1 (the safe,
 *  conservative assumption) when unknown, matching CoderScreen's original
 *  Scout-gating logic. Used to gate features that only make sense with
 *  multiple concurrent engine lanes (Scout's fan-out, Chat's Deep Research). */
export function engineMaxConcurrency(status: StatusPayload | null): number {
  const mc = status?.lastStart?.profile?.maxConcurrency;
  return typeof mc === 'number' && mc > 0 ? mc : 1;
}
