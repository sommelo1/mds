#!/usr/bin/env node
/**
 * Generates the conformance fixture tree (Annex B) from hand-authored
 * cases. Every case directory receives `case.md`, `case.mds`,
 * `expected.txt` plus optional extra files (imports, external contracts).
 *
 * The `expected.txt` files are the source of truth: they were written by
 * hand against the specification and both implementations must reproduce
 * them byte-for-byte. Never regenerate expectations from an engine.
 *
 * Usage: node tools/gen-fixtures.mjs
 * @module tools.gen-fixtures
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'conformance');

/** @type {Array<{dir:string, files:Record<string,string>}>} */
const CASES = [];
function caseDir(dir, files) { CASES.push({ dir, files }); }

/* ------------------------------------------------------------------ *
 * valid
 * ------------------------------------------------------------------ */

caseDir('valid/person', {
  'case.mds': `document Person

# "*" as title required

## Identity required
- Name: string required
- Age: integer optional min=0 max=130

## Tags optional
list string minItems=1
`,
  'case.md': `---
id: p-001
---

# Anna Profile

## Identity

- Name: Anna
- Age: 32

## Tags

- alpha
`,
  'expected.txt': `valid

summary: 0 errors, 0 warnings
`,
});

caseDir('valid/engine-full', {
  'case.mds': `document Engine

# "*" as title required

order strict

## Purpose required

prose required minLength=20

## Inputs required

table Inputs required
- Name: string required
- Type: string required

## Example zero-or-more

prose required

## Configuration optional

embed json required
`,
  'case.md': `# Signal Engine

## Purpose

Calculates normalized cross-asset signals.

## Inputs

| Name | Type |
|---|---|
| price | number |

## Example

First example text.

## Example

Second example text.

## Configuration

\`\`\`json
{"window": 20}
\`\`\`
`,
  'expected.txt': `valid

summary: 0 errors, 0 warnings
`,
});

caseDir('valid/order-any-shuffled', {
  'case.mds': `## B required

## A required
`,
  'case.md': `# T

## A

a

## B

b
`,
  'expected.txt': `valid

summary: 0 errors, 0 warnings
`,
});

/* ------------------------------------------------------------------ *
 * diagnostics/<code>
 * ------------------------------------------------------------------ */

caseDir('diagnostics/MDS-C101', {
  'case.mds': `# "*" as title required

## Outputs required
`,
  'case.md': `# Demo

## Inputs
`,
  'expected.txt': `invalid
- MDS-C101 error /Outputs case.md:1:1 contract case.mds:3 missing required section "Outputs"

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C102', {
  'case.mds': `additionalSections false

## Known required
`,
  'case.md': `# D

## Known

x

## Extra

y
`,
  'expected.txt': `invalid
- MDS-C102 error /Extra case.md:7:1 contract case.mds:1 unexpected section "Extra" under closed contract

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C103', {
  'case.mds': `# "*" as title required

## Body optional
`,
  'case.md': `## Body

text
`,
  'expected.txt': `invalid
- MDS-C103 error / case.md:1:1 contract case.mds:1 missing required document title

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C201', {
  'case.mds': `order strict

## Alpha required
## Beta required
`,
  'case.md': `# T

## Beta

b

## Alpha

a
`,
  'expected.txt': `invalid
- MDS-C201 error /Alpha case.md:7:1 contract case.mds:3 section "Alpha" out of declared order

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C202', {
  'case.mds': `## Rep zero-or-more

## Mid required
`,
  'case.md': `# T

## Rep

r1

## Mid

m

## Rep

r2
`,
  'expected.txt': `invalid
- MDS-C202 error /Rep[2] case.md:11:1 contract case.mds:1 repeated sections "Rep" are not contiguous

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C204', {
  'case.mds': `## Opt optional
`,
  'case.md': `# T

## Opt

a

## Opt

b
`,
  'expected.txt': `invalid
- MDS-C204 error /Opt[2] case.md:7:1 contract case.mds:1 too many occurrences of "Opt"

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C206-C207', {
  'case.mds': `## Sec required

additionalFields false

- Name: string required
- City: string required
`,
  'case.md': `# T

## Sec

- Name: X
- Zip: 12
`,
  'expected.txt': `invalid
- MDS-C207 error /Sec/Zip case.md:6:1 contract case.mds:3 unexpected field "Zip" under closed contract
- MDS-C206 error /Sec/City case.md:1:1 contract case.mds:6 missing required field "City"

summary: 2 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C301', {
  'case.mds': `## S required
- Age: integer required
`,
  'case.md': `# T

## S

- Age: abc
`,
  'expected.txt': `invalid
- MDS-C301 error /S/Age case.md:5:1 contract case.mds:2 value "abc" does not match type integer

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C302', {
  'case.mds': `## S required
- W: number required min=0
`,
  'case.md': `# T

## S

- W: -1
`,
  'expected.txt': `invalid
- MDS-C302 error /S/W case.md:5:1 contract case.mds:2 min=0 violated by "-1"

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C303', {
  'case.mds': `## S required
- Status: enum[draft, approved] required
`,
  'case.md': `# T

## S

- Status: review
`,
  'expected.txt': `invalid
- MDS-C303 error /S/Status case.md:5:1 contract case.mds:2 value "review" is not one of enum[draft, approved]

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C304', {
  'case.mds': `## S required
- V: union[string, number] required
`,
  'case.md': `# T

## S

- V: true
`,
  'expected.txt': `invalid
- MDS-C304 error /S/V case.md:5:1 contract case.mds:2 value "true" matches none of union[string, number]

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C305', {
  'case.mds': `## L required
list string maxItems=2
`,
  'case.md': `# T

## L

- alpha
- beta
- gamma
`,
  'expected.txt': `invalid
- MDS-C305 error /L/list case.md:2:1 contract case.mds:2 maxItems=2 violated (3)

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C307', {
  'case.mds': `## T required

additionalFields false

table Data required
- Name: string required
`,
  'case.md': `# T

## T

| Name | Extra |
|---|---|
| a | b |
`,
  'expected.txt': `invalid
- MDS-C307 error /T/Data/Extra case.md:5:1 contract case.mds:3 undeclared column "Extra" under closed contract

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C205', {
  'case.mds': `## S required

table D required
- Col: string required

prose required
`,
  'case.md': `# T

## S

para text

| Col |
|---|
| x |
`,
  'expected.txt': `invalid
- MDS-C205 error /S case.md:7:1 contract case.mds:1 content out of declared order in "S"

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C501', {
  'case.mds': `## A required

embed mermaid required
`,
  'case.md': `# T

## A

text
`,
  'expected.txt': `invalid
- MDS-C501 error /A/embed case.md:1:1 contract case.mds:3 missing required embed "mermaid"

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C503', {
  'case.mds': `## A required

embed json required
`,
  'case.md': `# T

## A

\`\`\`yaml
x: 1
\`\`\`
`,
  'expected.txt': `invalid
  - MDS-C503 error /A/embed case.md:5:1 contract case.mds:3 embedded block declares yaml, contract expects json

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-E001', {
  'case.mds': `## A required

embed json required
`,
  'case.md': `# T

## A

\`\`\`json
{oops
\`\`\`
`,
  'expected.txt': `invalid
    - MDS-E001 error /A/embed case.md:6:1 invalid JSON syntax (via json)

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-E410', {
  'case.mds': `## A required

embed json required
  schema: ./config.schema.json
`,
  'config.schema.json': '{}\n',
  'case.md': `# T

## A

\`\`\`json
{"ok": true}
\`\`\`
`,
  'expected.txt': `invalid
  - MDS-E410 error /A/embed case.md:5:1 required validation could not run; unavailable extension: json-schema (via core)

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/recursion-MDS-E001', {
  'case.mds': `## Appendix required

embed markdown required
  schema: ./fragment.mds
`,
  'fragment.mds': `## Config required

embed json required
`,
  'case.md': `# T

## Appendix

\`\`\`\`markdown
## Config

\`\`\`json
{bad
\`\`\`
\`\`\`\`
`,
  'expected.txt': `invalid
      - MDS-E001 error /Appendix/embed/Config/embed case.md:9:1 invalid JSON syntax (via json)

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C601', {
  'case.mds': `# "*" as title required
`,
  'case.md': `---
broken
---

# T
`,
  'expected.txt': `invalid
- MDS-C601 error /metadata case.md:2:1 malformed metadata entry "broken"

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C603', {
  'case.mds': `additionalFields false

# "*" as title required
`,
  'case.md': `---
key: v
---

# T
`,
  'expected.txt': `invalid
- MDS-C603 error /metadata/key case.md:2:1 contract case.mds:1 unexpected metadata key "key" under closed contract

summary: 1 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-C900', {
  'case.mds': `# "*" as title required

## Outputs required
`,
  'case.md': `## Whatever
`,
  'expected.txt': `invalid
# flags: --max 1
- MDS-C103 error / case.md:1:1 contract case.mds:1 missing required document title
- MDS-C900 warning / -:1:1 diagnostic list truncated (--max 1)

summary: 0 errors, 1 warnings
`,
});

caseDir('valid/semantic-optional-inert', {
  'case.mds': `## Purpose required

prose required

expect:
  Explain why the engine exists, its responsibility and boundaries.

validate:
  semantic: optional
`,
  'case.md': `# T

## Purpose

Explains the engine, its responsibility and where it ends.
`,
  'expected.txt': `valid

summary: 0 errors, 0 warnings
`,
});

caseDir('diagnostics/MDS-E410-semantic', {
  'case.mds': `## Purpose required

prose required

expect:
  Explain why the engine exists, its responsibility and boundaries.

validate:
  semantic: required
`,
  'case.md': `# T

## Purpose

Explains the engine.
`,
  'expected.txt': `invalid
- MDS-E410 error / case.mds:1:1 required extension unavailable: semantic (via core)

summary: 1 errors, 0 warnings
`,
});

/* ------------------------------------------------------------------ *
 * schema-phase failures (exit code 2)
 * ------------------------------------------------------------------ */

caseDir('schema/MDS-C002', {
  'case.mds': `frobnicate now
`,
  'case.md': '# T\n',
  'expected.txt': `error
- MDS-C002 error / case.mds:1:1 unsupported statement "frobnicate"

summary: 1 errors, 0 warnings
`,
});

caseDir('schema/MDS-C003', {
  'case.mds': `## S required
- A: frobnicate required
`,
  'case.md': '# T\n',
  'expected.txt': `error
- MDS-C003 error / case.mds:2:1 unknown type "frobnicate"

summary: 1 errors, 0 warnings
`,
});

caseDir('schema/MDS-C005', {
  'case.mds': `## S required
- A: integer min=abc
`,
  'case.md': '# T\n',
  'expected.txt': `error
- MDS-C005 error / case.mds:2:1 constraint "min" needs a number, got "abc"

summary: 1 errors, 0 warnings
`,
});

caseDir('schema/MDS-C401', {
  'case.mds': `use "./missing.mds"
`,
  'case.md': '# T\n',
  'expected.txt': `error
- MDS-C401 error / case.mds:1:1 unresolved reference "./missing.mds"

summary: 1 errors, 0 warnings
`,
});

caseDir('schema/MDS-C402', {
  'case.mds': `use "./other.mds"
`,
  'other.mds': `use "./case.mds"
`,
  'case.md': '# T\n',
  'expected.txt': `error
- MDS-C402 error / case.mds:1:1 import cycle detected: other.mds -> case.mds -> other.mds

summary: 1 errors, 0 warnings
`,
});

caseDir('schema/MDS-C404', {
  'case.mds': `define Foo
  string

define Foo
  string
`,
  'case.md': '# T\n',
  'expected.txt': `error
- MDS-C404 error / case.mds:4:1 duplicate definition "Foo"

summary: 1 errors, 0 warnings
`,
});

/* ------------------------------------------------------------------ */

for (const { dir, files } of CASES) {
  for (const [name, content] of Object.entries(files)) {
    const p = join(ROOT, dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}
rmSync(join(ROOT, '__orphans__'), { force: true, recursive: true });
console.log(`wrote ${CASES.length} conformance cases under ${ROOT}`);
