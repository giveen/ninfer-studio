#!/usr/bin/env node
// Version-parity gate.
//
// apps/web/package.json shipped at 0.3.3 while the root package.json (and
// both Cargo.toml / tauri.conf.json) moved on to 0.3.11 across several
// releases with nobody noticing — the web package version isn't read by
// anything at build or runtime, so it just silently drifts. This script
// asserts apps/web/package.json's version matches the root's. Run in CI
// (CI / Web) and locally:
//
//   node scripts/check-web-version.mjs
//
// Exit 0 = versions match; 1 = drift, with both versions printed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const rootVersion = readJson('package.json').version;
const webVersion = readJson('apps/web/package.json').version;

if (rootVersion !== webVersion) {
  console.error(
    `version drift: root package.json is ${rootVersion} but apps/web/package.json is ${webVersion}`,
  );
  process.exit(1);
}

console.log(`apps/web/package.json version matches root (${rootVersion})`);
