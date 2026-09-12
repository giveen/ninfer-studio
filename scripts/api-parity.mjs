#!/usr/bin/env node
// API-surface registration gate.
//
// The web app (apps/web/src/lib/api.ts) talks to the Rust control plane
// (dev standalone, in-process under Tauri when packaged). Any endpoint the
// UI calls that the control plane fails to register 404s at runtime — this
// is how the search/diff/sandbox endpoints once drifted under the retired
// Node sidecar, and the failure mode persists with one backend whenever a
// UI call is added without its route.
//
// This script enumerates every /api/* path the UI calls and asserts the
// control plane registers it. Run in CI (CI / Web) and locally:
//
//   node scripts/api-parity.mjs
//
// Exit 0 = all endpoints registered; 1 = drift, with the offending
// endpoints listed.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// --- Collect the endpoint paths the web app actually calls ----------------
// lib/api.ts is a barrel re-exporting lib/api/*.ts (split by domain: config,
// engine, models, chat, coder) — scan every file in that directory, not just
// the barrel, or a route literal moved into a domain module goes invisible
// to this gate and drift stops being caught.
function uiEndpoints() {
  const dir = 'apps/web/src/lib/api';
  const files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.ts'));
  const src = files.map((f) => read(join(dir, f))).join('\n');
  const paths = new Set();
  const re = /['"`]([^'"`$]*\/api\/[^'"`$?]*)/g;
  for (const m of src.matchAll(re)) {
    let p = m[1].trim();
    // Template placeholders (`/api/coder/jobs/${id}`) become wildcards.
    p = p.replace(/\$\{[^}]*\}/g, '*');
    if (p.startsWith('/api/')) paths.add(p);
  }
  return [...paths].sort();
}

// --- Collect routes each backend registers ---------------------------------
function rustRoutes() {
  const src = read('desktop/control/src/lib.rs');
  const routes = new Set();
  for (const m of src.matchAll(/\.route\("([^"]+)"/g)) {
    routes.add(m[1].replace(/\{[^}]*\}/g, '*'));
  }
  return [...routes];
}


// --- Match a UI path against the route list ----------------------------------
// Exact match, one-segment wildcard (`*`), or prefix routes.
function registered(uiPath, routes) {
  return routes.some((r) => {
    if (r === uiPath) return true;
    if (r.endsWith('*') && uiPath.startsWith(r.slice(0, -1))) return true;
    if (uiPath.endsWith('*') && r.startsWith(uiPath.slice(0, -1))) return true;
    const a = uiPath.split('/').map((s) => (s === '*' ? null : s));
    const b = r.split('/').map((s) => (s === '*' ? null : s));
    if (a.length !== b.length) return false;
    return a.every((s, i) => s === null || b[i] === null || s === b[i]);
  });
}

const ui = uiEndpoints();
const rust = rustRoutes();

const missing = ui.filter((p) => !registered(p, rust));

console.log(`API surface — ${ui.length} endpoints called by the web UI`);
if (missing.length) {
  console.log(`\nFAIL: control plane (desktop/control/src/lib.rs) is missing ${missing.length} endpoint(s) the UI calls:`);
  for (const p of missing) console.log(`  ${p}`);
  console.log('\nFix: register the missing routes in desktop/control/src/lib.rs, then re-run. Do NOT remove the UI call — the endpoint is real.');
  process.exit(1);
}
console.log('ok:  control plane registers every endpoint the UI calls');
