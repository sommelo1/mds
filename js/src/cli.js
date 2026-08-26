/**
 * Command-line interface for the `mds` command (section 58).
 *
 * Thin wrapper: argv parsing, file I/O and exit codes around the library
 * API (`validate.js`, `introspect.js`). All behavior lives in the library
 * so it can be embedded directly (lib-first).
 *
 * Commands: `validate`, `inspect`, `scaffold`, `extensions`, `skills`,
 * `help`.
 * Diagnostics go to stdout as the normative Markdown line stream;
 * operational failures go to stderr. Exit codes follow section 59:
 * 0 valid · 1 invalid · 2 schema/config failure.
 *
 * @module cli
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDocument } from './validate.js';
import { inspectSchema, scaffoldDoc } from './introspect.js';
import { draftSchema } from './draft.js';
import { builtinFormats } from './formats/index.js';
import { discoverPlugins } from './plugins.js';

const USAGE = `mds — Markdown Document Schema validator (spec v0.13)

Usage:
  mds validate <doc.md> <schema.mds> [--max N]
  mds inspect <schema.mds>
  mds scaffold <schema.mds>
  mds draft <doc.md>          # experimental
  mds extensions
  mds skills install [--force]
  mds help

Exit codes: 0 valid · 1 invalid · 2 schema/config failure
`;

function fail(msg) {
  process.stderr.write(`mds: ${msg}\n`);
  process.exitCode = 2;
}

/** Skill templates shipped with the package and their project targets. */
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const SKILL_TARGETS = [
  ...['validate', 'write', 'draft', 'install'].flatMap((skill) => [
    { template: `claude-SKILL-${skill}.md`, target: `.claude/skills/mds-${skill}/SKILL.md` },
    { template: `hermes-SKILL-${skill}.md`, target: `.hermes/skills/mds-${skill}/SKILL.md` },
    { template: `claude-SKILL-${skill}.md`, target: `.kilo/skills/mds-${skill}/SKILL.md` },
  ]),
];

/** Write agent skill files into the current project (idempotent). */
export function skillsInstall(force) {
  const lines = [];
  let written = 0;
  let skipped = 0;
  for (const { template, target } of SKILL_TARGETS) {
    if (existsSync(target) && !force) {
      lines.push(`- skip ${target} (exists, --force to overwrite)`);
      skipped++;
      continue;
    }
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, readFileSync(SKILLS_DIR + template, 'utf8').replace(/\r\n/g, '\n'));
    lines.push(`- write ${target}`);
    written++;
  }
  lines.push(`summary: ${written} written, ${skipped} skipped`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Parse `--max N` style flags from argv. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max') { flags.max = Number(argv[++i]); continue; }
    if (argv[i] === '--enable-optional-libs') { flags.libs = true; continue; }
    if (argv[i] === '--help') { flags.help = true; continue; }
    if (argv[i] === '--force') { flags.force = true; continue; }
    positional.push(argv[i]);
  }
  return { positional, flags };
}

/**
 * CLI main entry.
 * @param {string[]} argv raw arguments without the node/executable prefix
 */
export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];

  if (!cmd || cmd === 'help' || flags.help) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    if (cmd === 'extensions') {
      const plugins = await discoverPlugins(process.cwd());
      const all = new Map();
      for (const f of builtinFormats(flags.libs ?? false)) all.set(f.id, f);
      for (const p of plugins) for (const f of p.formats ?? []) if (f?.id) all.set(f.id, f);
      const rows = [...all.values()]
        .map((f) => `- ${f.id}: syntax=${f.capabilities.syntax ? 'yes' : 'recognition-only'}`);
      process.stdout.write(`${rows.join('\n')}\n`);
      return;
    }
    if (cmd === 'skills') {
      if (positional[1] !== 'install') return fail('skills requires "install" - try "mds help"');
      skillsInstall(flags.force ?? false);
      return;
    }
    if (cmd === 'inspect' || cmd === 'scaffold') {
      const file = positional[1];
      if (!file) return fail(`${cmd} requires a schema path`);
      const text = readFileSync(file, 'utf8');
      const r = cmd === 'inspect'
        ? inspectSchema(text, file)
        : scaffoldDoc(text, file);
      process.exitCode = r.exitCode;
      process.stdout.write(`${r.stream}\n`);
      return;
    }
    if (cmd === 'draft') {
      const file = positional[1];
      if (!file) return fail('draft requires a document path');
      const r = await draftSchema({
        docText: readFileSync(file, 'utf8'),
        docName: file,
      });
      process.stdout.write(r.schemaText);
      if (r.exitCode !== 0) {
        process.stderr.write(`mds: draft self-check failed\n${r.stream}\n`);
        process.exitCode = 1;
      } else {
        process.stderr.write('mds: draft ready on stdout - replace each "TODO:" expect line with real expectations, then re-check with: mds validate <doc.md> <schema.mds>\n');
      }
      return;
    }
    if (cmd === 'validate') {
      const [, docPath, schemaPath] = positional;
      if (!docPath || !schemaPath) return fail('validate requires <doc.md> <schema.mds>');
      const r = await validateDocument({
        docText: readFileSync(docPath, 'utf8'),
        docName: docPath,
        schemaText: readFileSync(schemaPath, 'utf8'),
        schemaName: schemaPath,
        baseDir: resolve(schemaPath, '..'),
        maxDiagnostics: Number.isFinite(flags.max) ? flags.max : null,
        enableOptionalLibs: flags.libs ?? false,
      });
      process.exitCode = r.exitCode;
      process.stdout.write(`${r.stream}\n`);
      return;
    }
    fail(`unknown command "${cmd}" — try "mds help"`);
  } catch (err) {
    fail(err?.message ?? String(err));
  }
}
