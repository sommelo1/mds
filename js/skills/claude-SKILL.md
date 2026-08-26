---
name: mds
description: >
  Validate, author and repair Markdown documents against MDS (.mds)
  contracts using the reference validator. Covers resolving the CLI on any
  platform and runtime, running validation, reading the Markdown diagnostic
  stream and the repair loop.
---

# MDS — Markdown Schema Workflow

MDS validates structured Markdown documents against `.mds` contracts.
A pair of `document.md` + `document.mds` is a complete validation unit.

## When this skill applies

Use it whenever the task involves:

- producing Markdown that must satisfy a `.mds` contract,
- interpreting output of the `mds validate` command,
- fixing validation failures reported as a Markdown diagnostic stream,
- creating or modifying `.mds` schemas themselves.

## Running the CLI (any platform)

Resolve the `mds` command once per session; first match wins:

1. `mds --version` succeeds → use `mds …` (pipx or npm global install).
2. A `.venv` exists in the workspace →
   - Windows: `.venv\Scripts\python.exe -m mds …`
   - POSIX: `.venv/bin/python -m mds …`
3. Otherwise use `npx --yes --package=mds-core mds …` (Node ≥ 18).

Inside this repository checkout `node js/bin/mds.js …` always works.
All subcommands behave identically on the JavaScript and Python builds:
`validate`, `inspect`, `scaffold`, `draft` (experimental), `extensions`,
`skills install`, `help`.

## The repair loop

1. Find the contract: look for `*.mds` near the target document
   (common locations: `docs/schemas/`, repository root, beside the file).
2. Read the contract before writing anything. It is short Markdown-like
   text: headings declare sections, `- Field: type cardinality` declares
   typed fields, `table`, `list`, `prose`, `embed` declare content.
3. Write or edit the document.
4. Run the validator (see above).
5. Interpret the diagnostic stream (grammar below).
6. Fix findings and re-run until the last line reads
   `summary: 0 errors, 0 warnings`.

Exit codes: `0` valid, `1` document invalid, `2` schema/config broken.
On exit code 2 do NOT touch the document — the `.mds` itself has errors
(codes `MDS-C0xx`, `MDS-C4xx`); fix or report those instead.

## Diagnostic stream grammar

One finding per line, rendered as a Markdown list item:

```text
- CODE severity /Semantic/Path file.ext:LINE:COL [contract schema.mds:N] message
  - deeper indented items come from delegated/embedded validators
```

- Indentation (two spaces per level) marks embedding depth, not importance.
- The last line is always `summary: N errors, M warnings` — trust it over
  counting yourself.
- `contract` points at the schema line that caused the check.

## Quick fix map

| Code | Meaning | Typical fix |
|---|---|---|
| MDS-C101 | missing required section | add heading matching label/pattern |
| MDS-C102 | unexpected section (closed contract) | remove/rename, or relax schema |
| MDS-C103 | missing document title | add `# Title` |
| MDS-C201/C202 | wrong order / interleaved repeats | reorder sections |
| MDS-C203 | required prose/occurrence missing | fill in prose |
| MDS-C204 | too many occurrences | remove duplicate section/table |
| MDS-C206 | missing required field | add `- Label: value` |
| MDS-C207 | unexpected field (closed contract) | remove or rename field |
| MDS-C208 | composition violated (oneOf/allOf/anyOf/not) | satisfy the declared field-set combination |
| MDS-C301 | value fails type check | see encodings below |
| MDS-C302 | constraint violated (min/pattern/…) | adjust value |
| MDS-C303/C304 | enum/const/union mismatch | pick an allowed value |
| MDS-C305 | collection rule (items/unique) | dedupe or resize |
| MDS-C501/C502/C503 | embed missing/unexpected/wrong format | fix fenced block |
| MDS-C504 | embedded content failed a super-minimal format sanity check | fix the fenced block; checks flag only unambiguous breakage |
| MDS-C601/C602/C603 | metadata entry malformed / type violation / closed contract | fix the front-matter line |
| MDS-E001 | embedded JSON syntax error | fix the JSON inside the fence |
| MDS-E410 | validator extension unavailable | report; needs a plugin, not edits |

## Value encodings (prevents MDS-C301)

- boolean: exactly `true` / `false` (lowercase)
- date: `YYYY-MM-DD`; datetime/time: RFC 3339 style
- null: leave value empty or write `null`
- numbers: dot decimal, no thousand separators
- uri/uuid/binary: standard forms (RFC 3986 / RFC 4122 / Base64)

## Authoring rules (avoid failures upfront)

- Fields are bullets with `Label: value` inside their section; nested
  bullets become object members when the schema declares them.
- Front matter between `---` lines is flat `key: value` text. It is NOT
  YAML: no `yes/on` coercion, no anchors, everything stays a string.
- Tables bind positionally to `table` declarations in order; column
  order inside the table is free; an empty cell means null.
- Embedded blocks: the fence info string must match the declared format
  (`json`, `mermaid`, …); JSON must be strict (no comments, no trailing
  commas). Built-in format checks are super-minimal sanity checks
  (`MDS-C504`): they flag only unambiguous structural breakage, stay
  silent on anything ambiguous, and make no claim of completeness.

## Starting from an existing document

Use the companion `mds-draft` skill: `mds draft <doc.md>` derives a starter
contract whose TODO expectations you refine semantically. See that skill for
the full roundtrip workflow.

Installing these instructions into another project: run `mds skills install`
there — see README → Agent skills.
