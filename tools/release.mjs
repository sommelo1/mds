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

function replace(file, from, to) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) fail(`${file}: missing ${from}`);
  writeFileSync(path, text.replaceAll(from, to), 'utf8');
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail('usage: node tools/release.mjs <x.y.z>');
}

const current = JSON.parse(readFileSync(join(root, 'js', 'package.json'), 'utf8')).version;
if (current === version) fail(`version already is ${version}`);

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
  'README.md',
  'js/package.json',
  'mds - Markdown Schema.md',
  'py/mds/__init__.py',
  'py/pyproject.toml',
  'tools/release.mjs',
], root);
run('git', ['commit', '-m', `Release ${version}`], root);
run('git', ['push', 'origin', 'main'], root);
run('git', ['tag', '-a', `v${version}`, '-m', `v${version}`], root);
run('git', ['push', 'origin', `v${version}`], root);

console.log(`Release ${version} committed, pushed and tagged as v${version}`);
