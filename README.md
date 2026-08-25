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

## Why MDS?

| | |
|---|---|
| 🧾 **Deterministic contract** | sections, ordering, cardinality, types, constraints — validated like code |
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

This writes six files — two skills for each supported agent:

- `.claude/skills/mds/SKILL.md` + `.claude/skills/mds-draft/SKILL.md`
- `.hermes/skills/{mds,mds-draft}/SKILL.md`
- `.kilo/command/{mds,mds-draft}.md`

Existing files are never overwritten without `--force`. The **`mds`** skill
covers validation and the repair loop (diagnostic grammar, fix map, value
encodings); the **`mds-draft`** skill covers the document-to-contract
roundtrip above. Both resolve the CLI platform- and runtime-independently
(Windows/POSIX, installed/venv/npx). Cloning *this* repository provides the
same skills automatically — no installation step needed.

Canonical sources live in [`skills/`](skills/) and all copies are generated
via `node tools/gen-skills.mjs`.

## Use as a library

Everything the CLI does is available programmatically — embed the library in
your own tooling, CI checks or MCP servers; use the CLI in shell pipelines
and LLM repair loops.

```js
// Node: npm i mds-core
import { validateDocument } from 'mds-core';
const { exitCode, stream } = await validateDocument({ docText, schemaText });
```

```python
# pip install mds-core
from mds import validate_document

r = validate_document(doc_text=doc, schema_text=schema,
                      doc_name="doc.md", schema_name="doc.mds")
print(r["exitCode"], r["stream"])
```

Results are plain data; the stream is exactly what the CLI prints, so tests
can assert against fixture bytes.

## Extensions — no core rebuilds

Format and semantic-validation extensions drop in with zero configuration:

- **Formats**: `embed svg`, `embed csv`, … bind by id/alias. Built-ins ship
  for `json` (full syntax check) and recognition-only stubs for common
  types; [`examples/ext-stubs-*`](examples/) covers everything GitHub/GitLab
  render specially (`math`, `plantuml`, `geojson`, `topojson`, `stl`,
  `abc`, …).
- **Semantic validators**: consume `expect` regions and may affect the
  verdict when a binding says `semantic: required`. A deterministic
  reference implementation lives in
  [`examples/ext-sem-rule-*`](examples/).
- Discovery follows platform convention: npm packages `mds-ext-*` /
  scoped `@mds/*` next to your run (JS), entry-point group `mds_ext`
  (Python). Missing-but-required extensions fail loudly with `MDS-E410`.

## Documentation

- [Specification (v0.13 Draft)](mds%20-%20Markdown%20Schema.md) — normative
- [Conformance fixtures](conformance/) — 33 cases, source of truth for behavior
- [Extension examples](examples/) — SVG checker, GFM stub pack, rule-based semantic validator
- [Agent skills](skills/) — canonical sources of the bundled agent instructions
- [Agent guidelines](AGENTS.md) — how coding agents work in this repository

## Development

```bash
git clone <your-fork-url> && cd mds

# JavaScript suite (Node >= 18)
node js/test/conformance.test.js        # 33/33

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

## Support & status

- Questions and bugs: [GitHub Issues](../../issues)
- Status: **beta (0.x)** against a draft specification — expect breaking
  changes before 1.0. Current MVP limitations (composition, conditions,
  granular `$ref#Name`) are rejected loudly with `MDS-C002` rather than
  approximated; see the
  [limitations table](AGENTS.md#known-mvp-limitations-do-not-fix-silently).

Maintained by **[Lorenz Sommer](https://www.linkedin.com/in/sommerlorenz/)**.
Contributions from everyone are welcome.

## License

[MIT](LICENSE)
