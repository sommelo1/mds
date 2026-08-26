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

process.exitCode = failed ? 1 : 0;
console.log(failed ? 'api tests: FAILURES' : 'api tests: all checks passed');
