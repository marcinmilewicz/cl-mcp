#!/usr/bin/env node
/**
 * Fetch NG-ZORRO sources (sparse checkout of components/) at a pinned tag.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'ng-zorro');
const repo = 'https://github.com/NG-ZORRO/ng-zorro-antd.git';
// Pinned to a release tag — bump deliberately, never track a moving branch.
const ref = process.env.NG_ZORRO_REF ?? '21.3.2';

if (existsSync(target)) {
  console.log(`[setup] ${target} already exists — skipping clone.`);
  console.log('[setup] Remove it manually if you want a fresh checkout.');
  process.exit(0);
}

console.log(`[setup] Sparse-cloning ${repo} (ref: ${ref}) into ${target}`);
execFileSync(
  'git',
  ['clone', '--depth', '1', '--branch', ref, '--filter=blob:none', '--sparse', repo, target],
  { stdio: 'inherit' },
);
execFileSync('git', ['sparse-checkout', 'set', 'components'], { cwd: target, stdio: 'inherit' });
console.log('[setup] Done.');
