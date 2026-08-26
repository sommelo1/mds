#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r.stdout || '';
}

function runQuiet(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r.stdout || '';
}

function replace(file, from, to) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) fail(`${file}: missing ${from}`);
  writeFileSync(path, text.replaceAll(from, to), 'utf8');
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail('usage: node tools/release.mjs <x.y.z>');
}

for (const [cmd, args] of [
  ['git', ['--version']],
  ['node', ['--version']],
  ['npm', ['--version']],
  [process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python'), ['--version']],
]) {
  try {
    runQuiet(cmd, args, root);
  } catch {
    fail(`missing required tool: ${Array.isArray(cmd) ? cmd.join(' ') : cmd}`);
  }
}

const branch = runQuiet('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
if (branch !== 'main') fail(`release must run on main, got ${branch || '<unknown>'}`);

const status = runQuiet('git', ['status', '--porcelain'], root).trim();
if (status) {
  fail(
    'working tree must be clean before release; commit or stash these changes first:\n' +
    status
  );
}

const current = JSON.parse(readFileSync(join(root, 'js', 'package.json'), 'utf8')).version;
if (current === version) fail(`version already is ${version}`);

for (const file of ['js/package.json', 'py/pyproject.toml', 'py/mds/__init__.py', 'README.md']) {
  if (!readFileSync(join(root, file), 'utf8').length) fail(`${file} is empty`);
}

replace('js/package.json', `"version": "${current}"`, `"version": "${version}"`);
replace('py/pyproject.toml', `version = "${current}"`, `version = "${version}"`);
replace('py/mds/__init__.py', `__version__ = "${current}"`, `__version__ = "${version}"`);
replace('mds - Markdown Schema.md', `**Version:** ${current}`, `**Version:** ${version}`);
replace('README.md', `Specification (v${current} Beta)`, `Specification (v${version} Beta)`);
replace('README.md', `Current release: **${current}**`, `Current release: **${version}**`);

run('npm', ['test'], join(root, 'js'));
run(join(root, '.venv', 'Scripts', 'python.exe'), ['-m', 'pytest', 'py/tests', '-q'], root);
run('node', ['tools/package-js.mjs'], root);
run('node', ['tools/package-py.mjs'], root);
run('git', ['add',
  '.github/workflows/publish.yml',
  'README.md',
  'js/package.json',
  'mds - Markdown Schema.md',
  'py/mds/__init__.py',
  'py/pyproject.toml',
  'tools/package-js.mjs',
  'tools/package-py.mjs',
  'tools/release.mjs',
], root);
run('git', ['commit', '-m', `Release ${version}`], root);
run('git', ['push', 'origin', 'main'], root);
run('git', ['tag', '-a', `v${version}`, '-m', `v${version}`], root);
run('git', ['push', 'origin', `v${version}`], root);

console.log(`Release ${version} committed, pushed and tagged as v${version}`);
