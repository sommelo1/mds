#!/usr/bin/env node
/**
 * Deploy every agent-skill document to its discovery and packaged targets.
 *
 * Canonical sources (single source of truth — edit these, never the copies):
 * - `skills/<name>.md`   complete, self-contained skill document:
 *   frontmatter, title, the immutable "Resolve the CLI" section and the
 *   per-skill "Workflow" section. The "Resolve the CLI" text must stay
 *   byte-identical to the `expect:` block of `skills/skills.mds`; the test
 *   suites enforce that, so keep the two in sync when editing either.
 *
 * Generated artifacts (verbatim copies of the source — never edit by hand):
 * - `.claude/skills/<name>/SKILL.md`
 * - `.hermes/skills/<name>/SKILL.md`
 * - `.kilo/skills/<name>/SKILL.md`
 * - `js/skills/{claude,hermes}-SKILL-<short>.md`
 * - `py/mds/skills/{claude,hermes}-SKILL-<short>.md`
 *
 * Deliberately NO `.kilo/command/*.md`: a command named like its skill
 * makes Kilo Code list the entry twice (skill + command share one menu).
 *
 * Run after editing a source or the contract: `node tools/gen-skills.mjs`.
 * Deterministic and idempotent; commit the resulting diff. Both test suites
 * validate every artifact against `skills/skills.mds`.
 *
 * @module tools.gen-skills
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'skills');

const sources = readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort();

const targets = [];
for (const file of sources) {
  const name = file.replace(/\.md$/, '');
  const short = name.replace(/^mds-/, '');
  const content = readFileSync(join(srcDir, file), 'utf8');
  targets.push(
    [join('.claude', 'skills', name, 'SKILL.md'), content],
    [join('.hermes', 'skills', name, 'SKILL.md'), content],
    [join('.kilo', 'skills', name, 'SKILL.md'), content],
    // packaged templates (flat names consumed by `mds skills install`)
    [join('js', 'skills', `claude-SKILL-${short}.md`), content],
    [join('js', 'skills', `hermes-SKILL-${short}.md`), content],
    [join('py', 'mds', 'skills', `claude-SKILL-${short}.md`), content],
    [join('py', 'mds', 'skills', `hermes-SKILL-${short}.md`), content],
  );
}

for (const [rel, content] of targets) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
console.log(`gen-skills: wrote ${targets.length} files from skills/*.md`);
