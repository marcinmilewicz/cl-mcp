#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'components');
const repo = 'https://github.com/angular/components.git';
const ref = process.env.ANGULAR_COMPONENTS_REF ?? 'main';

if (existsSync(target)) {
  console.log(`[setup] ${target} already exists — skipping clone.`);
  console.log('[setup] Remove it manually if you want a fresh checkout.');
  process.exit(0);
}

console.log(`[setup] Cloning ${repo} (ref: ${ref}) into ${target}`);
execFileSync('git', ['clone', '--depth', '1', '--branch', ref, repo, target], { stdio: 'inherit' });
console.log('[setup] Done.');
