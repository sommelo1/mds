/**
 * Dogfood check: every agent skill validates against `skills/skills.mds`.
 *
 * Anatomy: flat front-matter metadata (`name`, `description`), an identical
 * "Resolve the CLI" section, and a per-skill "Workflow" section. The
 * canonical sources are `skills/<name>.md` (complete, self-contained);
 * `tools/gen-skills.mjs` deploys them verbatim to every discovery/packaged
 * target. The "Resolve the CLI" text's canonical copy lives in the
 * contract's own `expect:` block under its `resolution` declaration, and
 * every source must match it byte-for-byte. Mirrors
 * `py/tests/test_skills_contract.py`.
 */
import { deepStrictEqual, strictEqual } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFiles } from '../src/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const contractPath = join(root, 'skills', 'skills.mds');
const srcDir = join(root, 'skills');
const tplDir = join(root, 'js', 'skills');
const sources = readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort();
const templates = readdirSync(tplDir).filter((f) => f.endsWith('.md')).sort();
const deployedDirs = ['.claude', '.hermes', '.kilo'];

for (const f of [...sources.map((f) => join(srcDir, f)),
  ...templates.map((f) => join(tplDir, f))]) {
  const r = await validateFiles({ docPath: f, schemaPath: contractPath });
  strictEqual(r.exitCode, 0, `${f}:\n${r.stream}`);
}
strictEqual(sources.length, 4);
strictEqual(templates.length, 8);

function resolveExpect() {
  // Git may check Markdown out as CRLF on Windows; the contract grammar and
  // the canonical skill content are line-ending independent.
  const t = readFileSync(contractPath, 'utf8').replace(/\r\n/g, '\n');
  const m = /^## "Resolve the CLI"[^\n]*\n\nexpect:\n((?: {2}[^\n]*\n)+)/m.exec(t);
  strictEqual(Boolean(m), true, 'contract lost its Resolve-the-CLI expect block');
  return m[1].replace(/^ {2}/gm, '').trimEnd();
}

function resolveSection(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  return normalized.slice(normalized.indexOf('## Resolve the CLI'),
    normalized.indexOf('## Workflow')).trimEnd();
}

const expectText = resolveExpect();
for (const f of sources) {
  strictEqual(resolveSection(readFileSync(join(srcDir, f), 'utf8')), expectText,
    `${f} resolve section drifted from skills.mds expect`);
}

for (const f of sources) {
  const name = f.replace(/\.md$/, '');
  const source = readFileSync(join(srcDir, f), 'utf8');
  for (const dir of deployedDirs) {
    const deployed = join(root, dir, 'skills', name, 'SKILL.md');
    const r = await validateFiles({ docPath: deployed, schemaPath: contractPath });
    strictEqual(r.exitCode, 0, `${deployed}:\n${r.stream}`);
    deepStrictEqual(readFileSync(deployed, 'utf8'), source, deployed);
  }
  for (const agent of ['claude', 'hermes']) {
    const packaged = join(tplDir, `${agent}-SKILL-${name.replace(/^mds-/, '')}.md`);
    deepStrictEqual(readFileSync(packaged, 'utf8'), source, packaged);
  }
}

console.log(`skills tests: ${sources.length} sources, ${templates.length} templates and all deployed copies match skills.mds`);
