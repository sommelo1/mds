#!/usr/bin/env node
/**
 * Regenerate every derived agent-skill copy from the canonical sources in
 * `skills/` (single source of truth).
 *
 * Derived artifacts (never edit by hand):
 * - `.claude/skills/<name>/SKILL.md`   — canonical verbatim
 * - `.hermes/skills/<name>/SKILL.md`   — canonical verbatim
 * - `.kilo/command/<name>.md`          — body + `$ARGUMENTS` target line
 * - `js/skills/*`, `py/mds/skills/*`   — packaged template copies
 *
 * Run after editing a canonical skill: `node tools/gen-skills.mjs`.
 * The script is deterministic and idempotent; commit the resulting diff.
 *
 * @module tools.gen-skills
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'skills');

/** Split YAML frontmatter from a canonical skill file. */
function parse(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(src);
  if (!m) throw new Error(`missing frontmatter in skill source: ${src}`);
  return { frontmatter: `---\n${m[1]}\n---\n`, body: m[2].replace(/^\r?\n/, '') };
}

const targets = [];
for (const file of readdirSync(srcDir).sort()) {
  if (!file.endsWith('.md')) continue;
  const name = file.replace(/\.md$/, '');
  const canonical = readFileSync(join(srcDir, file), 'utf8');
  const { frontmatter, body } = parse(canonical);
  const title = /^# (.+)$/m.exec(body)?.[1] ?? name;

  const kilo = [
    `# ${title}`,
    '',
    `Target: $ARGUMENTS.`,
    '',
    body.replace(/^# .+\r?\n/, '').trimStart(),
  ].join('\n');

  targets.push(
    [join('.claude', 'skills', name, 'SKILL.md'), canonical],
    [join('.hermes', 'skills', name, 'SKILL.md'), canonical],
    [join('.kilo', 'command', `${name}.md`), `${kilo}\n`],
    // packaged templates (flat names consumed by `mds skills install`)
    [join('js', 'skills', `claude-SKILL${name === 'mds' ? '' : `-${name.replace('mds-', '')}`}.md`), canonical],
    [join('js', 'skills', `hermes-SKILL${name === 'mds' ? '' : `-${name.replace('mds-', '')}`}.md`), canonical],
    [join('js', 'skills', `kilo-${name}.md`), `${kilo}\n`],
    [join('py', 'mds', 'skills', `claude-SKILL${name === 'mds' ? '' : `-${name.replace('mds-', '')}`}.md`), canonical],
    [join('py', 'mds', 'skills', `hermes-SKILL${name === 'mds' ? '' : `-${name.replace('mds-', '')}`}.md`), canonical],
    [join('py', 'mds', 'skills', `kilo-${name}.md`), `${kilo}\n`],
  );
}

for (const [rel, content] of targets) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
console.log(`gen-skills: wrote ${targets.length} files from skills/`);
