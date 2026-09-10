// Parity check for the two engine launch-arg builders:
//   TS: apps/sidecar/serve-args.js  buildServeArgs(profile)      (Node sidecar, dev)
//   Rust: desktop/control/src/types.rs build_serve_args(&profile, port) (AppImage control plane)
//
// Both MUST produce byte-identical argv for the canonical profiles in
// desktop/control/tests/parity/canonical-profile.json. The Rust side is
// enforced by the parity test in types.rs (`cargo test -p ninfier-control`);
// this script enforces the TS side against the same fixture.
//
// Usage:
//   node scripts/args-parity.mjs            # compare (exit 1 on drift)
//   node scripts/args-parity.mjs --update   # regenerate expected-args.json
//                                           # from the TS builder (then run
//                                           # cargo test to make Rust match)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildServeArgs } from '../apps/sidecar/serve-args.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'desktop', 'control', 'tests', 'parity');
const cases = JSON.parse(readFileSync(path.join(dir, 'canonical-profile.json'), 'utf8')).cases;
const expectedPath = path.join(dir, 'expected-args.json');

const actual = cases.map((c) => ({
  name: c.name,
  args: buildServeArgs({ ...c.profile, port: c.port }),
}));

if (process.argv.includes('--update')) {
  writeFileSync(expectedPath, JSON.stringify(actual, null, 2) + '\n');
  console.log(`[args-parity] regenerated ${path.relative(root, expectedPath)} from the TS builder`);
  process.exit(0);
}

const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
let failed = 0;
for (let i = 0; i < cases.length; i++) {
  const a = JSON.stringify(actual[i].args);
  const e = JSON.stringify(expected[i]?.args);
  if (a === e) {
    console.log(`[args-parity] ok   — ${cases[i].name} (${actual[i].args.length / 2} flags)`);
  } else {
    failed++;
    console.error(`[args-parity] FAIL — ${cases[i].name}`);
    console.error(`  expected: ${e}`);
    console.error(`  actual:   ${a}`);
  }
}
if (failed) {
  console.error(`\n[args-parity] ${failed} case(s) drifted between the TS builder and the fixture.`);
  console.error('If the TS change is intentional, run `node scripts/args-parity.mjs --update`');
  console.error('then make desktop/control/src/types.rs match (cargo test -p ninfier-control).');
  process.exit(1);
}
console.log('[args-parity] TS builder matches the shared fixture.');
