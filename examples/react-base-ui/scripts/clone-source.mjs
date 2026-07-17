#!/usr/bin/env node
/**
 * Fetch MUI's Base UI sources (sparse checkout: packages/react/src +
 * packages/utils) and link the internal `@base-ui/utils` package into the
 * example's node_modules so the analyzer's TypeChecker can resolve its
 * imports. React + @types/react come from the example's own npm install —
 * module resolution walks up from the cloned sources and finds them here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleRoot = path.resolve(here, '..');
const target = path.resolve(exampleRoot, 'base-ui');
const repo = 'https://github.com/mui/base-ui.git';
// Pinned to a release tag — bump deliberately, never track a moving branch.
const ref = process.env.BASE_UI_REF ?? 'v1.6.0';

if (!existsSync(target)) {
  console.log(`[setup] Sparse-cloning ${repo} (ref: ${ref}) into ${target}`);
  execFileSync(
    'git',
    ['clone', '--depth', '1', '--branch', ref, '--filter=blob:none', '--sparse', repo, target],
    { stdio: 'inherit' },
  );
  execFileSync('git', ['sparse-checkout', 'set', 'packages/react/src', 'packages/utils'], {
    cwd: target,
    stdio: 'inherit',
  });
} else {
  console.log(`[setup] ${target} already exists — skipping clone.`);
  console.log('[setup] Remove it manually if you want a fresh checkout.');
}

// Link the in-repo @base-ui/utils package (its exports point at ./src/*.ts,
// so the analyzer resolves it directly from source).
const scopeDir = path.resolve(exampleRoot, 'node_modules', '@base-ui');
const linkPath = path.join(scopeDir, 'utils');
mkdirSync(scopeDir, { recursive: true });
rmSync(linkPath, { recursive: true, force: true });
symlinkSync(path.join(target, 'packages', 'utils'), linkPath, 'dir');
console.log(`[setup] Linked @base-ui/utils -> ${path.join(target, 'packages', 'utils')}`);
console.log('[setup] Done.');
