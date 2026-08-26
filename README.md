# MDS — Markdown Document Schema

[![npm](https://img.shields.io/npm/v/mds-core?logo=npm)](https://www.npmjs.com/package/mds-core)
[![PyPI](https://img.shields.io/pypi/v/mds-core?logo=pypi)](https://pypi.org/project/mds-core/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Turn Markdown into a contract-driven, testable document format.**
MDS validates Markdown documents against `.mds` contracts — deterministic
structure, types and constraints, plus native **semantic expectations**
(`expect:`) that humans and LLMs read directly.

> Markdown has structure, but no native way to define what a valid document
> must contain. MDS adds that missing layer — for humans writing docs, for
> AI-generated documents, and for the acceptance test between the two.

## Watch the Introduction

[![Watch the MDS introduction](https://img.youtube.com/vi/4rEo9036y2w/maxresdefault.jpg)](https://youtu.be/4rEo9036y2w)

## Why MDS?

| | |
|---|---|
| 🧾 **Deterministic contract** | sections, ordering, cardinality, types, constraints — validated like code |
| 🕳️ **Presence vs. emptiness** | `optional` says the element may be *missing*; `nullable(na)` says its value may be *unknown* — structural and data absence never blur |
| 🧠 **Semantic expectation** | `expect:` states what content *belongs* in a region; readable by humans and LLMs |
| 🔌 **Optional semantic validation** | `validate:` delegates evaluation to extensions (rule-based, embeddings, LLM judges) |
| 🔁 **Two byte-identical engines** | JavaScript (Node ≥ 18, zero deps) and Python (≥ 3.10, stdlib-only) agree on every conformance fixture |
| 🤖 **LLM-native** | the same `.mds` file is generation spec *and* acceptance test; diagnostics are plain Markdown lines you can paste back into a repair prompt |

```text
MDS Contract
├── deterministic contract
│   ├── structure
│   ├── types
│   └── constraints
└── semantic expectation
    └── expect
        ├── directly readable by humans
        ├── directly readable by LLMs
        └── optionally evaluated by extensions
```

## Quick start

```bash
# CLI without installing anything (Node >= 18)
npx --yes --package=mds-core mds validate doc.md doc.mds

# Python side
pipx install mds-core
mds validate doc.md doc.mds
```

A contract (`doc.mds`):

```mds
document Report

# "*" as title required

## Summary required

prose required minLength=50

expect:
  Explain what happened, who is affected and what happens next.
  Do not repeat raw data from the tables above.

validate:
  semantic: optional

## Metrics required

table Metrics one-or-more
- Name: string required
- Value: number required
```

Validation output is plain Markdown — exit code 0 valid, 1 invalid,
2 broken contract:

```text
$ npx mds validate doc.md doc.mds
- MDS-C301 error /Metrics[1]/Value doc.md:12:1 contract doc.mds:9 value "n/a" does not match type number

summary: 1 errors, 0 warnings
```

Two kinds of "missing", two keywords — the contract states both explicitly,
so an LLM never has to invent data to satisfy a gap:

```mds
table Metrics
- Value: number                  # must be present and concrete
- Baseline: number nullable      # present, but may be empty or null
- Delta: number nullable(na)     # additionally na counts as "no value"
- Owner: string optional         # column may be left out entirely
```

Rule of thumb: `optional` = the box may be missing · `nullable` = the box is
there but may be empty. Empty values bypass type checks and constraints;
under `unique`, two empties count as equal. Full matrix, examples and the
normative rules live in spec section 23.1.

### Open by default

A contract binds exactly what it declares — nothing else. Undeclared
sections, fields or columns are legal: declaring a parent heading does not
constrain its subtree, so an LLM filling a region you left unspecified
stays free and the document still validates.

```mds
## Details required       # binds this heading only;
                          # everything nested below: unconstrained
```

Strictness is bought explicitly, document-wide or per section:

```mds
additionalSections false   # undeclared heading -> MDS-C102
additionalFields false     # undeclared field/column -> MDS-C207/C307
```

## CLI reference

Both builds (npm `mds-core` via Node ≥ 18, PyPI `mds-core` via Python ≥ 3.10)
expose the same `mds` command with byte-identical behavior. Examples below
use `mds` — installed via `pipx install mds-core` or `npm i -g mds-core`;
without installing use `npx --yes --package=mds-core mds …` or
`python -m mds …` from an active venv.

| Command | Purpose |
|---|---|
| `mds validate <doc.md> <schema.mds>` | validate a document; prints Markdown-line diagnostics, exit 0 valid · 1 invalid · 2 broken contract |
| `mds inspect <schema.mds>` | machine-readable report of a contract |
| `mds scaffold <schema.mds>` | generate a document skeleton from a contract |
| `mds draft <doc.md>` | **experimental** — derive a starter contract from an existing document; self-checks the result and hints next steps on stderr |
| `mds extensions` | list discovered format extensions |
| `mds skills install [--force]` | write agent skills into the current project |
| `mds help` | usage overview |

The draft → fill → validate roundtrip is its own workflow:

```bash
mds draft doc.md > doc.mds        # 1. mechanical starter contract
# 2. replace each "TODO:" expect line with real expectations (see skill below)
mds validate doc.md doc.mds       # 3. re-check until summary: 0 errors, 0 warnings
mds scaffold doc.mds              # 4. roundtrip sanity: skeleton ≈ original
```

## Agent skills

One command makes coding agents MDS-aware in your own project — Claude Code,
Hermes and Kilo pick the files up automatically:

```bash
mds skills install                                # after installing mds-core
npx --yes --package=mds-core mds skills install   # without installing
```

This writes twelve files — four skills for each supported agent:

- `.claude/skills/{mds-validate,mds-write,mds-draft,mds-install}/SKILL.md`
- `.hermes/skills/{mds-validate,mds-write,mds-draft,mds-install}/SKILL.md`
- `.kilo/skills/{mds-validate,mds-write,mds-draft,mds-install}/SKILL.md`

Existing files are never overwritten without `--force`. Each skill is a
short loop around the deterministic CLI: **`mds-validate`** runs the
validator and repairs until clean (`0` done · `1` fix document ·
`2` fix contract); **`mds-write`** generates a document against a
contract; **`mds-draft`** covers the document-to-contract roundtrip
above; **`mds-install`** is the exceptional path that resolves or
installs the CLI when none is available. All resolve the CLI platform-
and runtime-independently (Windows/POSIX, installed/venv/npx). Cloning
*this* repository provides the same skills automatically — no
installation step needed. All four share one enforced anatomy (front
matter, identical CLI resolution, per-skill workflow) and validate
against [`skills/skills.mds`](skills/skills.mds); the resolution
section's canonical text is stored verbatim in that contract's
`expect:` block and injected into every copy — written once,
byte-identical everywhere. Both test suites enforce the contract.

| Skill | Use it for | What it does |
|---|---|---|
| `mds-validate` | an existing document and contract | Validates, reads the deterministic diagnostic stream, repairs the document or contract according to the exit code, then checks each semantic `expect:` block. |
| `mds-write` | a contract and a new document | Reads the full contract, writes only the required Markdown structure and values, then hands off to the validation loop. |
| `mds-draft` | an existing Markdown document | Runs `mds draft`, replaces its `TODO:` expectation stubs with real content requirements, validates the result, then uses `scaffold` as a roundtrip check. |
| `mds-install` | no usable `mds` command | Probes installed, venv and ad-hoc CLI invocations; only when none work, installs the package persistently and verifies the command. |

`mds-install` is deliberately an exceptional skill: the other three try
the resolution ladder first and invoke it only when no CLI is available.
Skills never invent document facts merely to make a validation finding
disappear; `optional` permits missing structure, while `nullable` permits
an explicitly present but unknown value.

Codex and other AGENTS.md-only agents have no skill discovery; `AGENTS.md`
in this repository points them at all four canonical skills in `skills/`.

Canonical sources live in [`skills/`](skills/) and all copies are generated
via `node tools/gen-skills.mjs`.

## Use as a library

Everything the CLI does is available programmatically — embed the library in
your own tooling, CI checks or MCP servers; use the CLI in shell pipelines
and LLM repair loops.

### 1 · Validate files

Content lives on disk? Pass paths — they are read **and** used as the
diagnostic labels, so names can never drift from the sources.

```python
# Python - paths are read AND used as diagnostic labels
from mds import validate_files

r = validate_files("doc.md", "doc.mds")
print(r["exitCode"], r["stream"])
```

```js
// JavaScript - identical behavior, no manual file reading either
import { validateFiles } from 'mds-core';

const { exitCode, stream } = await validateFiles({
  docPath: 'doc.md',
  schemaPath: 'doc.mds',
});
console.log(exitCode, stream);
```

### 2 · Validate strings

Content already in memory (templates, stdin, LLM output)? Define the pair
inline and pass the texts. Streams have no filename here — labels default
to `case.md` / `case.mds` unless you pass names yourself.

```python
# Python - document and contract defined inline, passed as texts
from mds import validate_document

doc_text = """# Shopping Note

## Body

Buy oat milk."""

schema_text = """document Note

# "*" as title required

## Body required

prose required minLength=1"""

r = validate_document(doc_text=doc_text, schema_text=schema_text)
print(r["exitCode"], r["stream"])
```

```js
// JavaScript - same inline pair, texts passed directly
import { validateDocument } from 'mds-core';

const docText = `# Shopping Note

## Body

Buy oat milk.`;

const schemaText = `document Note

# "*" as title required

## Body required

prose required minLength=1`;

const { exitCode, stream } = await validateDocument({ docText, schemaText });
console.log(exitCode, stream);
```

### 3 · Validate streams

Transport hooks that deliver chunks instead of complete buffers? Drain any
source: file objects, `StringIO`/`BytesIO` and chunk iterables (Python);
Node/Web streams and sync/async iterables of string or utf8 chunks
(JavaScript).

```python
# Python - StringIO here, but files/BytesIO/chunk iterables work alike
import io
from mds import validate_streams

doc_text = """# Shopping Note

## Body

Buy oat milk."""

schema_text = """document Note

# "*" as title required

## Body required

prose required minLength=1"""

r = validate_streams(io.StringIO(doc_text), io.StringIO(schema_text))
print(r["exitCode"], r["stream"])
```

```js
// JavaScript - Readable.from here, but any chunk iterable works too,
// including utf8 buffers split mid-character
import { Readable } from 'node:stream';
import { validateStreams } from 'mds-core';

const docText = `# Shopping Note

## Body

Buy oat milk.`;

const schemaText = `document Note

# "*" as title required

## Body required

prose required minLength=1`;

const { exitCode } = await validateStreams({
  docStream: Readable.from([docText]),
  schemaStream: Readable.from([schemaText]),
});
console.log(exitCode);
```

All three entry points return the same three-part result:

| Field | Audience | Content |
|---|---|---|
| `exitCode` | machines | `0`, `1` or `2` — see exit codes below |
| `diagnostics` | **code** | array of structured findings: `{ code, severity, path, file, line, column, message, contractFile, contractLine, depth }` — identical keys in JS and Python |
| `stream` | **LLMs & humans** | the rendered Markdown diagnostic lines plus `summary:` — exactly what the CLI prints |

**Exit codes** — stable across the CLI and every library entry point:

| Code | Meaning | What to do |
|---|---|---|
| `0` | **valid** — the document satisfies every declaration of the contract | nothing; ship it |
| `1` | **invalid** — the document violates a valid contract (codes `MDS-C1xx…C6xx`, `MDS-E*`) | inspect `diagnostics`/`stream`, fix the document or relax the contract |
| `2` | **broken contract** — the `.mds` itself could not be processed (syntax errors `MDS-C0xx`, unresolved references/cycles `MDS-C4xx`) | fix the schema — never paper over it by editing the document |

```js
console.log(r.diagnostics[0].code);      // e.g. 'MDS-C101'
console.log(r.diagnostics[0].line);      // jump target for editors/CI
```

```python
print(r["diagnostics"][0]["code"])
print(r["diagnostics"][0]["line"])
```

So pipelines can branch on `exitCode`, tools can act on `diagnostics`, and
the same run can be pasted into an LLM repair prompt as `stream`.

## Extensions — no core rebuilds

Format and semantic-validation extensions drop in with zero configuration:

- **Formats**: `embed svg`, `embed csv`, … bind by id/alias. Built-ins ship
  for `json` (full syntax check) plus **super-minimal sanity checks** for
  the formats GitHub/GitLab render natively — `math`, `mermaid`,
  `plantuml`, `abc`, `csv`, `geojson`, `topojson`, `stl`. They flag only
  unambiguous structural breakage, stay silent on anything ambiguous,
  and make no claim of completeness (findings surface as `MDS-C504`);
  `svg` and friends stay recognition-only.
  [`examples/ext-stubs-*`](examples/) shows the extension interface for
  deeper checks (`math`, `plantuml`, `geojson`, `topojson`, `stl`, `abc`, …).
- **Semantic validators**: consume `expect` regions and may affect the
  verdict when a binding says `semantic: required`. A deterministic
  reference implementation lives in
  [`examples/ext-sem-rule-*`](examples/).
- Discovery follows platform convention: npm packages `mds-ext-*` /
  scoped `@mds/*` next to your run (JS), entry-point group `mds_ext`
  (Python). Missing-but-required extensions fail loudly with `MDS-E410`.

## Documentation

- [Specification (v0.17.1 Beta)](mds%20-%20Markdown%20Schema.md) — normative
- [Conformance fixtures](conformance/) — 49 cases, source of truth for behavior
- [Extension examples](examples/) — SVG checker, GFM stub pack, rule-based semantic validator
- [Agent skills](skills/) — canonical sources of the bundled agent instructions
- [Agent guidelines](AGENTS.md) — how coding agents work in this repository

## Development

```bash
git clone <your-fork-url> && cd mds

# JavaScript suite (Node >= 18)
node js/test/conformance.test.js        # 49/49

# Python suite (inside .venv/)
.venv/Scripts/python.exe -m pytest py/tests -q   # Windows
.venv/bin/python -m pytest py/tests -q           # Linux/macOS
```

Both implementations MUST stay byte-identical on all fixtures. After an
intentional behavior change regenerate fixtures with
`node tools/gen-fixtures.mjs` and review the diff carefully. Agent skills
are regenerated from `skills/` with `node tools/gen-skills.mjs`.

## Contributing

Issues and pull requests are welcome. Ground rules:

1. Behavior changes touch **spec paragraph + JS + Python + fixtures in the
   same change set** — never one side alone.
2. Diagnostic grammar is stable (`CODE severity path file:line:col
   [contract f:l] message`, summary line last); tools and repair loops
   depend on it.
3. Spec keywords MUST/SHOULD/MAY follow RFC 2119 as used by the
   specification's conformance section.

### Release packaging

Use the repository tooling to build and verify release artifacts before
publishing:

```bash
node tools/package-py.mjs   # clean build + wheel/sdist content check
node tools/package-js.mjs   # clean npm pack + tarball content check
node tools/release.mjs 0.17.2  # bump, test, commit, push, tag
```

The Python release gate checks that `mds/__init__.py`, `mds/__main__.py`,
`mds/cli.py` and the shipped skills are present in the wheel and sdist.
The JavaScript gate checks that `bin/mds.js`, `src/cli.js`, `src/index.js`,
`README.md`, `package.json` and the shipped skills are present in the npm
tarball.
Both gates run together because the project ships a Python and a JavaScript
runtime from the same version line.

## Support & status

- Questions and bugs: [GitHub Issues](../../issues)
- Current release: **0.17.1**
- Status: **beta (0.x)** against a draft specification — expect breaking
  changes before 1.0. Composition (`oneOf/allOf/anyOf/not`), conditional
  contracts (`when`), granular `$ref#Name` imports and typed metadata are
  implemented per the conformance fixtures; remaining limitations live in
  the
  [limitations table](AGENTS.md#known-mvp-limitations-do-not-fix-silently).

Maintained by **[Lorenz Sommer](https://www.linkedin.com/in/sommerlorenz/)**.
Contributions from everyone are welcome.

## License

[MIT](LICENSE)
