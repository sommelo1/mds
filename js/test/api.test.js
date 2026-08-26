#!/usr/bin/env node
/**
 * Public API surface test: all three entry points — files, strings,
 * streams — must produce byte-identical verdicts and diagnostic streams
 * for the same document/schema pair (person conformance fixture).
 *
 * @module test.api
 */
import { createReadStream, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDocument, validateFiles, validateStreams } from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docPath = join(root, 'conformance', 'valid', 'person', 'case.md');
const schemaPath = join(root, 'conformance', 'valid', 'person', 'case.mds');

let failed = false;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = true;
};

const files = await validateFiles({ docPath, schemaPath });
check('files: valid fixture passes', files.exitCode === 0, files.stream);

const docText = readFileSync(docPath, 'utf8');
const schemaText = readFileSync(schemaPath, 'utf8');
const strings = await validateDocument({
  docText, schemaText,
  docName: docPath, schemaName: schemaPath, baseDir: root,
});
check('strings: identical to files', JSON.stringify(strings) === JSON.stringify(files));

const streams = await validateStreams({
  docStream: createReadStream(docPath),
  schemaStream: createReadStream(schemaPath),
  docName: docPath, schemaName: schemaPath, baseDir: root,
});
check('streams: identical to files', JSON.stringify(streams) === JSON.stringify(files));

// utf8 safety: 7-byte chunks force splits inside multi-byte sequences
const docBytes = Buffer.from(docText.replace('Name: Anna', 'Name: Anna — ok'), 'utf8');
async function* byteChunks() {
  for (let i = 0; i < docBytes.length; i += 7) yield docBytes.subarray(i, i + 7);
}
const sliced = await validateStreams({
  docStream: byteChunks(),
  schemaStream: createReadStream(schemaPath),
  docName: docPath, schemaName: schemaPath, baseDir: root,
});
check('streams: utf8-safe across byte splits', JSON.stringify(sliced) === JSON.stringify(files));

// structured diagnostics: programmatic access alongside the rendered stream
check('valid run: empty diagnostics array', Array.isArray(files.diagnostics) && files.diagnostics.length === 0);

const badDoc = readFileSync(join(root, 'examples', 'draft-roundtrip.md'), 'utf8');
const mismatch = await validateDocument({
  docText: badDoc, schemaText,
  docName: 'draft-roundtrip.md', schemaName: 'person.mds', baseDir: root,
});
const d0 = mismatch.diagnostics[0] ?? {};
check('mismatch: one structured finding',
  mismatch.exitCode === 1 &&
  mismatch.diagnostics.length === 1 &&
  d0.code === 'MDS-C101' &&
  d0.severity === 'error' &&
  typeof d0.message === 'string' &&
  d0.contractFile === 'person.mds' &&
  Number.isInteger(d0.contractLine),
  JSON.stringify(mismatch.diagnostics));
const errCount = mismatch.diagnostics.filter((d) => d.severity === 'error').length;
check('summary count matches diagnostics array', mismatch.stream.endsWith(`summary: ${errCount} errors, ${mismatch.diagnostics.length - errCount} warnings`));

process.exitCode = failed ? 1 : 0;
console.log(failed ? 'api tests: FAILURES' : 'api tests: all checks passed');
