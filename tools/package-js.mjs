#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jsDir = join(root, 'js');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  if (r.status !== 0) {
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    process.exit(r.status ?? 1);
  }
  return r.stdout || '';
}

const pkg = JSON.parse(readFileSync(join(jsDir, 'package.json'), 'utf8'));
const pyproject = readFileSync(join(root, 'py', 'pyproject.toml'), 'utf8');
const pyInit = readFileSync(join(root, 'py', 'mds', '__init__.py'), 'utf8');
if (!pyproject.includes(`version = "${pkg.version}"`)) {
  console.error(`py/pyproject.toml version does not match ${pkg.version}`);
  process.exit(1);
}
if (!pyInit.includes(`__version__ = "${pkg.version}"`)) {
  console.error(`py/mds/__init__.py version does not match ${pkg.version}`);
  process.exit(1);
}

const raw = process.platform === 'win32'
  ? run('cmd.exe', ['/d', '/s', '/c', `${npmCmd} pack --json --dry-run`], jsDir)
  : run(npmCmd, ['pack', '--json', '--dry-run'], jsDir);
const packs = JSON.parse(raw.trim() || '[]');
if (!Array.isArray(packs) || packs.length !== 1) {
  console.error('npm pack did not return exactly one package description');
  process.exit(1);
}
const files = new Set((packs[0].files || []).map((f) => f.path));
const required = new Set([
  'bin/mds.js',
  'src/cli.js',
  'src/index.js',
  'skills/claude-SKILL-validate.md',
  'skills/hermes-SKILL-install.md',
  'README.md',
  'package.json',
  'LICENSE',
]);
const missing = [...required].filter((name) => !files.has(name));
if (missing.length) {
  console.error(`npm package missing: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`Built npm package artifacts for ${pkg.version}`);
