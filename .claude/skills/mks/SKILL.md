---
name: mks
description: >
  Validate, author and repair Markdown documents against MKS (.mks)
  contracts using the bundled reference validator. Covers running the
  validator, reading its Markdown diagnostic stream and the repair loop.
---

# MKS — Markdown Schema Workflow

MKS validates structured Markdown documents against `.mks` contracts.
A pair of `document.md` + `document.mks` is a complete validation unit.

## When this skill applies

Use it whenever the task involves:

- producing Markdown that must satisfy a `.mks` contract,
- interpreting output of the `mks validate` command,
- fixing validation failures reported as a Markdown diagnostic stream,
- creating or modifying `.mks` schemas themselves.

## The repair loop

1. Find the contract: look for `*.mks` near the target document
   (common locations: `docs/schemas/`, repository root, beside the file).
2. Read the contract before writing anything. It is short Markdown-like
   text: headings declare sections, `- Field: type cardinality` declares
   typed fields, `table`, `list`, `prose`, `embed` declare content.
3. Write or edit the document.
4. Run the validator (see Invocation below).
5. Interpret the diagnostic stream (grammar below).
6. Fix findings and re-run until the last line reads
   `summary: 0 errors, 0 warnings`.

Exit codes: `0` valid, `1` document invalid, `2` schema/config broken.
On exit code 2 do NOT touch the document — the `.mks` itself has errors
(codes `MKS-C0xx`, `MKS-C4xx`); fix or report those instead.

## Invocation (this repository)

```bash
node js/bin/mks.js validate <doc.md> <schema.mks>      # Node ≥18
.venv/Scripts/python.exe -m mks validate <doc.md> <schema.mks>   # Windows
.venv/bin/python -m mks validate <doc.md> <schema.mks>           # POSIX
mks validate <doc.md> <schema.mks>                     # if installed
```

Other commands: `inspect`, `scaffold`, `extensions`, `help`.

## Diagnostic stream grammar

One finding per line, rendered as a Markdown list item:

```text
- CODE severity /Semantic/Path file.ext:LINE:COL [contract schema.mks:N] message
  - deeper indented items come from delegated/embedded validators
```

- Indentation (two spaces per level) marks embedding depth, not importance.
- The last line is always `summary: N errors, M warnings` — trust it over
  counting yourself.
- `contract` points at the schema line that caused the check.

## Quick fix map

| Code | Meaning | Typical fix |
|---|---|---|
| MKS-C101 | missing required section | add heading matching label/pattern |
| MKS-C102 | unexpected section (closed contract) | remove/rename, or relax schema |
| MKS-C103 | missing document title | add `# Title` |
| MKS-C201/C202 | wrong order / interleaved repeats | reorder sections |
| MKS-C203 | required prose/occurrence missing | fill in prose |
| MKS-C204 | too many occurrences | remove duplicate section/table |
| MKS-C206 | missing required field | add `- Label: value` |
| MKS-C207 | unexpected field (closed contract) | remove or rename field |
| MKS-C301 | value fails type check | see encodings below |
| MKS-C302 | constraint violated (min/pattern/…) | adjust value |
| MKS-C303/C304 | enum/const/union mismatch | pick an allowed value |
| MKS-C305 | collection rule (items/unique) | dedupe or resize |
| MKS-C501/C502/C503 | embed missing/unexpected/wrong format | fix fenced block |
| MKS-E001 | embedded JSON syntax error | fix the JSON inside the fence |
| MKS-E410 | validator extension unavailable | report; needs a plugin, not edits |

## Value encodings (prevents MKS-C301)

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
  commas).
