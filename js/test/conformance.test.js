#!/usr/bin/env node
/**
 * Conformance runner (Annex B).
 *
 * Walks every directory under `conformance/` that contains a `case.md`,
 * runs {@link module:validate.validateDocument} against it and compares
 * stdout byte-for-byte with `expected.txt` (comments starting with `#`
 * are stripped). The first expected line doubles as the verdict tag:
 * `valid`, `invalid` or `error` (exit code 2, schema broken). Fixture
 * flags such as `# flags: --max 1` are applied to the run.
 *
 * @module test.conformance
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDocument } from '../src/validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance');

/** Recursively collect case directories. */
function collectCases(dir, out = []) {
  if (!statSync(dir).isDirectory()) return out;
  if (exists(join(dir, 'case.md'))) out.push(dir);
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collectCases(p, out);
  }
  return out;
}
const exists = (p) => { try { statSync(p); return true; } catch { return false; } };

/** Split expected.txt into verdict, flags and comparable lines. */
function parseExpected(text) {
  const lines = text.split(/\r?\n/);
  const verdict = lines[0]?.trim();
  const flags = {};
  const body = [];
  for (const ln of lines.slice(1)) {
    const fm = ln.match(/^#\s*flags:\s*(.+)$/);
    if (fm) {
      const toks = fm[1].trim().split(/\s+/);
      for (let k = 0; k < toks.length; k++) {
        if (toks[k] === '--max') flags.max = Number(toks[k + 1]);
      }
      continue;
    }
    if (ln.startsWith('#')) continue;
    body.push(ln);
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  return { verdict, flags, body };
}

async function main() {
  const cases = collectCases(root).sort();
  let pass = 0;
  const failures = [];
  for (const dir of cases) {
    const rel = dir.slice(root.length + 1);
    const expected = parseExpected(readFileSync(join(dir, 'expected.txt'), 'utf8'));
    const r = await validateDocument({
      docText: readFileSync(join(dir, 'case.md'), 'utf8'),
      docName: 'case.md',
      schemaText: readFileSync(join(dir, 'case.mds'), 'utf8'),
      schemaName: 'case.mds',
      baseDir: dir,
      maxDiagnostics: expected.flags.max ?? null,
      enableOptionalLibs: false,
    });
    const gotLines = r.stream.split('\n');
    while (gotLines.length && gotLines[gotLines.length - 1] === '') gotLines.pop();
    const wantVerdict = expected.verdict === 'error' ? 2 : expected.verdict === 'valid' ? 0 : 1;
    const okStream = gotLines.join('\n') === expected.body.join('\n');
    const okExit = r.exitCode === wantVerdict;
    if (okStream && okExit) {
      pass++;
      console.log(`PASS ${rel}`);
    } else {
      failures.push(rel);
      console.log(`FAIL ${rel}`);
      if (!okExit) console.log(`  exit: want ${wantVerdict}, got ${r.exitCode}`);
      if (!okStream) {
        console.log('  --- want ---');
        for (const l of expected.body) console.log(`  | ${l}`);
        console.log('  --- got ----');
        for (const l of gotLines) console.log(`  | ${l}`);
      }
    }
  }
  console.log(`\n${pass}/${pass + failures.length} conformance cases passed`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}

main();
