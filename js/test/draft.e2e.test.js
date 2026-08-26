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
    /^(\s*)TODO: describe what the (.+) (section must convey|(\w+) must show)\.$/gm,
    (_m, indent, label, kind, noun) => `${indent}${kind === 'section must convey'
      ? (CANNED[label] ?? `The ${label} section states its key facts concisely.`)
      : `The ${noun} shows the content this document requires.`}`,
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
// exact titles print their literal text; only glob titles scaffold a
// `<Title>` placeholder — drafts always derive exact titles now
check('roundtrip keeps title', doc.title === null || skel.includes(doc.title.text));

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

// Scenario 3 — five draft defects pinned as regressions. Each document
// previously made the self-check fail (exit 1) or produced wrong output.

// 3a. multiple H1 headings: exact title, other H1s become top-level
//     sections at their real level (glob "*" consumed them all).
const multiH1Doc = `# Report

## Intro

Some intro text here.

# Appendix A

Appendix prose.

# Appendix B

More appendix prose.
`;
const mdraft = await draftSchema({ docText: multiH1Doc, docName: 'multi.md' });
check('multi-H1 self-check passes', mdraft.exitCode === 0, mdraft.stream);
check('multi-H1 exact title', /^# "Report" as title required$/m.test(mdraft.schemaText));
check('multi-H1 chapters at level 1', /^# Appendix A required$/m.test(mdraft.schemaText));

// 3b. fenced example content must not leak into structure
const fencedDoc = `# Doc

## Real

Real prose.

\`\`\`mds
# Fake Heading

- Fake: value

| FakeCol |
|---------|
| x       |
\`\`\`
`;
const fdraft = await draftSchema({ docText: fencedDoc, docName: 'fenced.md' });
check('fenced self-check passes', fdraft.exitCode === 0, fdraft.stream);
check('fenced content ignored', !fdraft.schemaText.includes('Fake'), fdraft.schemaText);

// 3c. nested subsections bind at their real heading level
const nestedDoc = `# Doc

## Parent

Parent prose.

### Child

Child prose.
`;
const ndraft = await draftSchema({ docText: nestedDoc, docName: 'nested.md' });
check('nested self-check passes', ndraft.exitCode === 0, ndraft.stream);
check('nested child at level 3', /^### Child required$/m.test(ndraft.schemaText));

// 3d. ragged tables: rows longer than the header create no phantom column
const raggedDoc = `# Doc

## Data

| A | B |
|---|---|
| 1 | 2 | extra |
| 3 | 4 |
`;
const rdraft = await draftSchema({ docText: raggedDoc, docName: 'ragged.md' });
check('ragged self-check passes', rdraft.exitCode === 0, rdraft.stream);
check('no phantom column', !/- : /.test(rdraft.schemaText), rdraft.schemaText);

// 3e. emphasis-wrapped bullet labels become plain fields
const boldDoc = `# Doc

## Ext

- **Formats**: embed svg and csv
- Plain: value
`;
const bdraft = await draftSchema({ docText: boldDoc, docName: 'bold.md' });
check('bold-label self-check passes', bdraft.exitCode === 0, bdraft.stream);
check('emphasis stripped from field label', /^- Formats: string$/m.test(bdraft.schemaText));

// 3f. content order follows the document (table before prose), and
//     non-expressible alternation relaxes the section with `order any`
const orderDoc = `# Doc

## Mixed

| X | Y |
|---|---|
| 1 | 2 |

Table first prose after.

## Alternating

Open prose.

| A |
|---|
| 1 |

Closing prose.
`;
const odraft = await draftSchema({ docText: orderDoc, docName: 'order.md' });
check('order self-check passes', odraft.exitCode === 0, odraft.stream);
const mixedIdx = odraft.schemaText.indexOf('table Mixed');
const mixedProse = odraft.schemaText.indexOf('prose required minLength', mixedIdx);
check('table declared before its trailing prose', mixedIdx > -1 && mixedProse > mixedIdx);
check('alternating section stays prose-unbound',
  !/## Alternating required[\s\S]*?^prose /m.test(odraft.schemaText));

// 3g. emphasis-wrapped table headers become plain column names
const emphDoc = `# Doc

## Matrix

| *Structural* | **Data** |
|--------------|----------|
| a            | b        |
`;
const edraft = await draftSchema({ docText: emphDoc, docName: 'emph.md' });
check('emphasized headers self-check passes', edraft.exitCode === 0, edraft.stream);
check('emphasis stripped from columns', /^- Structural: string$/m.test(edraft.schemaText)
  && /^- Data: string$/m.test(edraft.schemaText));

// 3h. embedded diagrams/content bind as embeds WITH expect stubs — every
//     observed fence language is declared, unknown ones included
const embedDoc = `# Doc

## Diagram

Some context.

\`\`\`mermaid
flowchart TD
    A --> B
\`\`\`

## Sometimes

Text only.

## Always

Intro.

\`\`\`mermaid
flowchart LR
    C --> D
\`\`\`

\`\`\`note
sticky content
\`\`\`
`;
const vdraft = await draftSchema({ docText: embedDoc, docName: 'viz.md' });
check('embed self-check passes', vdraft.exitCode === 0, vdraft.stream);
check('mermaid bound required in its sections', /^embed mermaid$/m.test(vdraft.schemaText)
  && !/^embed mermaid optional$/m.test(vdraft.schemaText));
check('unknown language bound too', /^embed note$/m.test(vdraft.schemaText));
check('embed carries expect stub',
  /embed mermaid\n\nexpect:\n {2}TODO: describe what the diagram must show\./
    .test(vdraft.schemaText));
check('embed binds semantic optional',
  /embed note\n\nexpect:[\s\S]*?validate:\n {2}semantic: optional/.test(vdraft.schemaText));

// 3i. embeds pair POSITIONALLY: mixed-language sections emit one slot per
//     fence in document order; prose-fence-prose stays prose-unbound
const mixedFenceDoc = `# Doc

## Gallery

Intro sentence.

\`\`\`mds
document Example
\`\`\`

Middle words.

\`\`\`text
raw notes
\`\`\`

Closing words.

\`\`\`mermaid
flowchart TD
    A --> B
\`\`\`
`;
const mfdraft = await draftSchema({ docText: mixedFenceDoc, docName: 'mixed.md' });
check('mixed fences self-check passes', mfdraft.exitCode === 0, mfdraft.stream);
const slotOrder = ['embed mds', 'embed text', 'embed mermaid']
  .map((p) => mfdraft.schemaText.indexOf(p));
check('three slots in document order', slotOrder.every((i) => i > -1)
  && slotOrder[0] < slotOrder[1] && slotOrder[1] < slotOrder[2]);
check('slot languages exact', !mfdraft.schemaText.includes('contract expects'));

const pepDoc = `# Doc

## Wrapped

Before the block.

\`\`\`json
{"a": 1}
\`\`\`

After the block.
`;
const pddraft = await draftSchema({ docText: pepDoc, docName: 'pep.md' });
check('prose-fence-prose self-check passes', pddraft.exitCode === 0, pddraft.stream);
check('wrapped keeps embed, drops prose',
  !/## Wrapped required[\s\S]*?^prose /m.test(pddraft.schemaText)
  && /^embed json$/m.test(pddraft.schemaText));

process.exitCode = failed ? 1 : 0;
console.log(failed ? 'draft E2E: FAILURES' : 'draft E2E: all checks passed');
