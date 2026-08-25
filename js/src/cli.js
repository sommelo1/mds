/**
 * Command-line interface for the `mds` command (section 58).
 *
 * Thin wrapper: argv parsing, file I/O and exit codes around the library
 * API (`validate.js`, `introspect.js`). All behavior lives in the library
 * so it can be embedded directly (lib-first).
 *
 * Commands: `validate`, `inspect`, `scaffold`, `extensions`, `help`.
 * Diagnostics go to stdout as the normative Markdown line stream;
 * operational failures go to stderr. Exit codes follow section 59:
 * 0 valid · 1 invalid · 2 schema/config failure.
 *
 * @module cli
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateDocument } from './validate.js';
import { inspectSchema, scaffoldDoc } from './introspect.js';
import { builtinFormats } from './formats/index.js';
import { discoverPlugins } from './plugins.js';

const USAGE = `mds — Markdown Document Schema validator (spec v0.13)

Usage:
  mds validate <doc.md> <schema.mds> [--max N]
  mds inspect <schema.mds>
  mds scaffold <schema.mds>
  mds extensions
  mds help

Exit codes: 0 valid · 1 invalid · 2 schema/config failure
`;

function fail(msg) {
  process.stderr.write(`mds: ${msg}\n`);
  process.exitCode = 2;
}

/** Parse `--max N` style flags from argv. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max') { flags.max = Number(argv[++i]); continue; }
    if (argv[i] === '--enable-optional-libs') { flags.libs = true; continue; }
    if (argv[i] === '--help') { flags.help = true; continue; }
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
