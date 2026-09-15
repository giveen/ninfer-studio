#!/usr/bin/env node
// Commit-hygiene gate.
//
// Half of recent history (~250 commits in 14d) is `Agent auto-commit:
// patched|edited <absolute-path>` noise on the same three files — it breaks
// `git bisect`, review, and revert. This script fails a PR/push that adds
// such commits, so agents must squash to one meaningful message before merge.
// Run in CI (CI / Hygiene) and locally:
//
//   node scripts/check-commit-hygiene.mjs [--range <git-range>]
//
// Default range: `origin/main..HEAD` when origin/main exists, else HEAD only.
// Exit 0 = clean; 1 = banned message found, listed with the fix.

import { execSync } from 'node:child_process';

const banned = [
  /^agent auto-commit/i,
  /^(patched|edited)\s+\//i,
  /\bpatched\s+\/mnt\//i,
];

const rangeArg = process.argv.indexOf('--range');
let range = rangeArg === -1 ? null : process.argv[rangeArg + 1];
// Single-commit check: `HEAD` alone would list all reachable history via
// `git log HEAD` — pin it to one commit.
const singleCommit = range === 'HEAD';
if (!range) {
  try {
    execSync('git rev-parse --verify --quiet origin/main', { stdio: 'ignore' });
    range = 'origin/main..HEAD';
  } catch {
    range = 'HEAD';
  }
}
const single = singleCommit || range === 'HEAD';
const logCmd = single
  ? `git log -1 --pretty=format:'%H %s' ${range}`
  : `git log --pretty=format:'%H %s' ${range}`;

let subjects;
try {
  subjects = execSync(logCmd, { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
} catch (e) {
  console.error(`check-commit-hygiene: cannot resolve range ${range}: ${e.message}`);
  process.exit(1);
}

if (subjects.length === 0) {
  console.log('check-commit-hygiene: no commits in range, clean');
  process.exit(0);
}

let failed = false;
for (const line of subjects) {
  const space = line.indexOf(' ');
  const sha = line.slice(0, space);
  const subject = line.slice(space + 1);
  if (!subject) {
    console.error(`${sha.slice(0, 8)}: empty commit subject — use "<type>(<scope>): <what>"`);
    failed = true;
    continue;
  }
  if (banned.some((re) => re.test(subject))) {
    console.error(
      `${sha.slice(0, 8)}: banned auto-commit message "${subject}" — squash to one meaningful "<type>(<scope>): <what>" commit before merge`,
    );
    failed = true;
  } else if (subject.length > 72) {
    console.warn(`warning: ${sha.slice(0, 8)}: subject >72 chars — shorten next time: "${subject}"`);
  }
}

if (failed) process.exit(1);
console.log(`check-commit-hygiene: ${subjects.length} commit(s) in ${range}, clean`);
