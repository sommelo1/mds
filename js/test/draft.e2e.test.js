#!/usr/bin/env node
/**
 * End-to-end roundtrip test for the experimental draft workflow:
 *
 *   md --(draft)--> mds --(fill TODOs, as an agent would)--> mds'
 *      --(validate)--> clean --(scaffold)--> md-skeleton ~= original
 *
 * The "fill" step mechanizes exactly what the `mds-draft` skill instructs,
 * so the full lifecycle runs deterministically without invoking an LLM.
 *
 * @module test.draftE2E
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { draftSchema } from '../src/draft.js';
import { validateDocument } from '../src/validate.js';
import { scaffoldDoc } from '../src/introspect.js';
import { flattenSections, parseDocument } from '../src/mddoc.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docPath = join(root, 'examples', 'draft-roundtrip.md');

let failed = false;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = true;
};

const CANNED = {
  Summary: 'States release date, downtime, latency effect and cost effect of the quarter.',
  Owner: 'Names the owning team, its lead and the team size plus on-call duty.',
  Highlights: 'Lists two to four concrete achievements of the quarter as short bullets.',
  Metrics: 'Reports latency, availability and deploy frequency with units; empty notes allowed.',
  'Incident Example': 'Describes one past incident with cause and the fix that followed.',
  'Appendix Config': 'Shows the production region and replica configuration as strict JSON.',
};
const fillTodo = (schemaText) =>
  schemaText.replace(
    /^(\s*)TODO: describe what the (.+) section must convey\.$/gm,
    (_m, indent, label) => `${indent}${CANNED[label] ?? `The ${label} section states its key facts concisely.`}`,
  );

const docText = readFileSync(docPath, 'utf8');

const draft = await draftSchema({ docText, docName: 'draft-roundtrip.md' });
check('draft self-check passes', draft.exitCode === 0, draft.stream);
check('draft emits expect TODO stubs', /^ {2}TODO: describe what the .+ section must convey\.$/m.test(draft.schemaText));

const filled = fillTodo(draft.schemaText);
check('agent fill replaces all TODOs', !filled.includes('TODO:'));

const reval = await validateDocument({
  docText, docName: 'draft-roundtrip.md',
  schemaText: filled, schemaName: 'draft-roundtrip.mds',
  baseDir: root, maxDiagnostics: null, enableOptionalLibs: false,
});
check('filled contract validates document', reval.exitCode === 0, reval.stream);

const skel = scaffoldDoc(filled, 'draft-roundtrip.mds', root).stream;
const doc = parseDocument(docText);
const labels = flattenSections(doc.sections)
  .map(({ sec }) => sec)
  .filter((s) => !(doc.title && s.level === 1 && s.line === doc.title.line))
  .map((s) => s.label);
const missing = labels.filter((l) => !skel.includes(`## ${l}`));
check('roundtrip keeps all section titles', missing.length === 0, missing.join(', '));
check('roundtrip keeps title', doc.title === null || skel.includes('<Title>'));

const flat = flattenSections(doc.sections).map(({ sec }) => sec);
const tbl = flat.flatMap((s) => s.tables)[0];
if (tbl) {
  check('roundtrip keeps table columns',
    skel.includes(`| ${tbl.columns.join(' | ')} |`),
    tbl.columns.join(', '));
}
const fences = flat.flatMap((s) => s.fences).map((f) => f.lang);
for (const lang of fences) {
  check(`roundtrip keeps ${lang} embed`, skel.includes(`\`\`\`${lang}`));
}
check('roundtrip keeps prose placeholders', skel.includes('...'));

// Scenario 2 — structural absence vs data absence (section 23.1): empty
// cells and empty field values are missing DATA, so the draft must emit
// `nullable`, and its own self-check proves the contract accepts them.
const gapDoc = `# G

## M

| A | B |
|---|---|
| 1 |   |
| 2 | 5 |

## F

- Age: 42
- Score:
`;
const gdraft = await draftSchema({ docText: gapDoc, docName: 'gaps.md' });
check('gap draft self-check passes', gdraft.exitCode === 0, gdraft.stream);
check('gap draft marks empty column nullable', /^- B: integer nullable$/m.test(gdraft.schemaText), gdraft.schemaText);
check('gap draft marks empty field nullable', /^- Score: string nullable$/m.test(gdraft.schemaText));
check('gap draft keeps required concrete column', /^- A: integer$/m.test(gdraft.schemaText));

process.exitCode = failed ? 1 : 0;
console.log(failed ? 'draft E2E: FAILURES' : 'draft E2E: all checks passed');
