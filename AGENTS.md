# AGENTS.md — MDS repository guide

Instructions for coding agents working in this repository
(OpenAI Codex and any other AGENTS.md-compatible tool).

## Project

MDS — Markdown Document Schema. A schema language validating structured Markdown
(`.md`) against `.mds` contracts, with native semantic expectations (`expect:`).
Normative specification: `mds - Markdown Schema.md` (v0.13). Reference implementations:

- `js/`  — Node ≥18, zero runtime dependencies, ESM, npm package `mds-core`
- `py/`  — Python ≥3.10, stdlib-only, package `mds-core`, console script `mds`

Both MUST stay byte-identical on all conformance fixtures
(`conformance/**`: `case.md` + `case.mds` + `expected.txt`). The fixtures
are the source of truth for behavior; never change one side alone.

## Commands

```bash
node --version && python --version        # environment check

# JavaScript side
cd js && npm test                         # conformance suite
node bin/mds.js validate doc.md schema.mds

# Python side — ALWAYS via the isolated venv, never global pip/python
.venv/Scripts/python.exe -m pytest py/tests -q   # Windows
.venv/Scripts/python.exe -m mds validate doc.md schema.mds
```

Regenerate fixtures after intentional spec-behavior changes:
`node tools/gen-fixtures.mjs` — review the diff carefully.

## Rules for agents

1. Behavior changes require: spec paragraph + both implementations +
   fixtures updated in the SAME change set.
2. Identical-output rule: JS and Python must produce byte-equal
   diagnostic streams on identical input. No locale, no timestamps, no
   library-dependent messages in output.
3. Diagnostics are Markdown list items
   (`[indent]- CODE severity path file:line:col [contract f:l] message`),
   summary line last: `summary: N errors, M warnings`. Never break this
   grammar — LLM repair loops and CI depend on it.
4. Zero-config plugin contract: extensions drop in as npm packages
   `mds-ext-*` (JS) or entry-points group `mds_ext` (Python). Built-ins
   live in `src/formats` / `formats` using the same interface.
5. Optional third-party libraries (ajv/jsonschema/yaml) are opt-in via
   env `MDS_ENABLE_OPTIONAL_LIBS=1`. Default builds MUST NOT depend on
   them for deterministic output.
6. Documentation lives in JSDoc (JS) and Google-style docstrings (Py);
   generated via `npm run docs` (jsdoc) and `pdoc`. Update docs with code.
7. Python work runs exclusively inside `.venv/`; never install into the
   global interpreter. Node work stays inside `js/node_modules`.
8. Spec keywords MUST/SHOULD/MAY follow RFC 2119 as defined in the
   specification's conformance section.
9. Agent skills are deployed by `node tools/gen-skills.mjs` from the
   canonical sources `skills/<name>.md` — each a complete, self-contained
   document (frontmatter, title, the immutable "Resolve the CLI" section,
   and the per-skill Workflow). Every copy under `.claude/`, `.hermes/`,
   `.kilo/`, `js/skills/` and `py/mds/skills/` is a verbatim generated
   artifact; edit a source or the contract, regenerate, commit — never
   patch a deployed copy. The "Resolve the CLI" text's canonical copy
   lives in the `expect:` block of `skills/skills.mds`; every source must
   match it byte-for-byte. Both test suites validate every artifact
   against the contract and enforce that byte-identity.

## MDS skills for this repository

When a task involves authoring or validating Markdown against `.mds`
contracts, repairing validation failures, reading diagnostic streams, or
deriving contracts from existing documents, read the canonical skills —
each is a short loop around the deterministic CLI:

- `skills/mds-validate.md` — validate a pair and repair until clean
  (exit 0 done · 1 fix document · 2 fix contract)
- `skills/mds-write.md` — generate a document against a contract
- `skills/mds-draft.md` — document-to-contract roundtrip (`mds draft`)
- `skills/mds-install.md` — exceptional path: resolve or install the CLI

Codex has no skill discovery mechanism; these pointers are its interface.
Claude Code, Hermes and Kilo Code load the generated copies under
`.claude/skills/`, `.hermes/skills/` and `.kilo/skills/` automatically.

## Known MVP limitations (do not "fix" silently)

Composition (`oneOf/allOf/anyOf/not`, MDS-C208), conditional contracts
(`when`), granular `$ref "path#Name"` resolution, typed metadata entries
(`metadata` block, MDS-C602/C603) and `nullable` data-absence semantics
(section 23.1, MDS-C007/C008) ARE implemented; their normative behavior
is defined by the fixtures under `conformance/` — change fixtures first,
then both implementations in lockstep. Built-in super-minimal embed sanity
checks (math, mermaid, plantuml, abc, csv, geojson, topojson, stl;
findings as MDS-C504) are specified in spec section 40.1 and MUST stay
byte-identical across runtimes. They are deliberately incomplete: checks
flag only unambiguous structural breakage and stay silent on anything
ambiguous. Deepening them belongs in format extensions, not in Core.
