#!/usr/bin/env node

import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const pyDir = join(root, 'py');
const localPyExe = process.platform === 'win32'
  ? join(root, '.venv', 'Scripts', 'python.exe')
  : join(root, '.venv', 'bin', 'python');

function resolvePythonExe() {
  if (existsSync(localPyExe)) {
    return localPyExe;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

const python = resolvePythonExe();

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

for (const p of [join(pyDir, 'build'), join(pyDir, 'dist'), join(pyDir, 'mds_core.egg-info')]) {
  rmSync(p, { recursive: true, force: true });
}

run(python, ['-m', 'pip', 'install', '--quiet', 'build'], root);
run(python, ['-m', 'build'], pyDir);

const version = JSON.parse(readFileSync(join(root, 'js', 'package.json'), 'utf8')).version;
const pyproject = readFileSync(join(pyDir, 'pyproject.toml'), 'utf8');
if (!pyproject.includes(`version = "${version}"`)) {
  console.error(`pyproject.toml version does not match ${version}`);
  process.exit(1);
}
const pyInit = readFileSync(join(pyDir, 'mds', '__init__.py'), 'utf8');
if (!pyInit.includes(`__version__ = "${version}"`)) {
  console.error(`mds/__init__.py version does not match ${version}`);
  process.exit(1);
}

const distFiles = readdirSync(join(pyDir, 'dist'));
if (!distFiles.length) {
  console.error('no Python dist artifacts were produced');
  process.exit(1);
}

const check = `
import sys, tarfile, zipfile, pathlib
dist = pathlib.Path(sys.argv[1])
wheel = next(dist.glob('*.whl'))
sdist = next(dist.glob('*.tar.gz'))
wheel_names = set(zipfile.ZipFile(wheel).namelist())
sdist_names = set(tarfile.open(sdist, 'r:gz').getnames())
required = {
    'mds/__init__.py',
    'mds/__main__.py',
    'mds/cli.py',
    'mds/skills/claude-SKILL-validate.md',
    'mds/skills/hermes-SKILL-install.md',
}
wheel_missing = sorted(name for name in required if name not in wheel_names)
sdist_missing = sorted(name for name in required if not any(name in item for item in sdist_names))
if wheel_missing or sdist_missing:
    print('wheel missing:', wheel_missing)
    print('sdist missing:', sdist_missing)
    raise SystemExit(1)
print(wheel.name)
print(sdist.name)
`;
run(python, ['-c', check, join(pyDir, 'dist')], root);

console.log(`Built Python package artifacts for ${version}`);
