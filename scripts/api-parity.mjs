#!/usr/bin/env node
// API-surface parity gate.
//
// The web app (apps/web/src/lib/api.ts) talks to TWO interchangeable
// backends: the zero-dependency Node sidecar (dev) and the Rust control
// plane (AppImage). Any endpoint the UI calls that one backend fails to
// register 404s silently on that platform (this is how the search/diff/
// sandbox endpoints drifted: present in the sidecar, absent in Rust).
//
// This script enumerates every /api/* path the UI calls and asserts both
// backends register it. Run in CI (CI / Sidecar) and locally:
//
//   node scripts/api-parity.mjs
//
// Exit 0 = all endpoints registered on both backends; 1 = drift, with the
// offending endpoints listed per backend.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// --- Collect the endpoint paths the web app actually calls ----------------
function uiEndpoints() {
  const src = read('apps/web/src/lib/api.ts');
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

function sidecarRoutes() {
  const src = read('apps/sidecar/server.js');
  const routes = new Set();
  for (const m of src.matchAll(/['"]\/api\/[^'"]*['"]/g)) {
    routes.add(m[0].slice(1, -1));
  }
  return [...routes];
}

// --- Match a UI path against a backend's route list -------------------------
// Exact match, one-segment wildcard (`*`), or prefix routes (sidecar
// `startsWith` handlers register a trailing-slash path like
// `/api/coder/jobs/`).
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
const side = sidecarRoutes();

const missingRust = ui.filter((p) => !registered(p, rust));
const missingSidecar = ui.filter((p) => !registered(p, side));

console.log(`API surface parity — ${ui.length} endpoints called by the web UI`);
let fail = false;
for (const [name, missing] of [
  ['Rust control plane (desktop/control/src/lib.rs)', missingRust],
  ['Node sidecar (apps/sidecar/server.js)', missingSidecar],
]) {
  if (missing.length) {
    fail = true;
    console.log(`\nFAIL: ${name} is missing ${missing.length} endpoint(s) the UI calls:`);
    for (const p of missing) console.log(`  ${p}`);
  } else {
    console.log(`ok:  ${name} registers every endpoint the UI calls`);
  }
}
if (fail) {
  console.log('\nFix: register the missing routes in the lagging backend (mirror the other\nbackend\'s handler), then re-run. Do NOT remove the UI call — the endpoint is real.');
  process.exit(1);
}
