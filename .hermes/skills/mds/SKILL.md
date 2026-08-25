---
name: mds
description: >
  Validate, author and repair Markdown documents against MDS (.mds)
  contracts with the bundled reference validator. Best-effort adapter for
  Hermes-compatible skill loaders (same content as the Claude Code skill;
  adjust the discovery path if your Hermes version differs).
---

# MDS — Markdown Schema Workflow

MDS validates structured Markdown documents against `.mds` contracts.
A pair of `document.md` + `document.mds` is a complete validation unit.

## When this skill applies

- producing Markdown that must satisfy a `.mds` contract,
- interpreting `mds validate` output,
- fixing failures reported as a Markdown diagnostic stream,
- creating or editing `.mds` schemas.

## The repair loop

1. Locate the contract (`*.mds` beside/near the document or in
   `docs/schemas/`). Read it first — headings declare sections,
   `- Field: type cardinality` declares typed fields, plus `table`,
   `list`, `prose`, `embed` declarations.
2. Write or edit the document.
3. Validate:

   ```bash
   node js/bin/mds.js validate <doc.md> <schema.mds>
   # or: .venv/Scripts/python.exe -m mds validate <doc.md> <schema.mds>
   ```

4. Read diagnostics (grammar below); fix; repeat until
   `summary: 0 errors, 0 warnings`.

Exit codes: 0 valid · 1 invalid · 2 schema/config broken.
Exit 2 ⇒ the `.mds` is faulty (codes MDS-C0xx/C4xx): repair the schema
or escalate; do not compensate in the document.

## Diagnostic grammar

```text
- CODE severity /Path file.ext:L:C [contract schema.mds:N] message
  - indented items = findings from delegated/embedded validators
```

Final line always: `summary: N errors, M warnings`.

## Quick fix map

| Code | Meaning | Fix |
|---|---|---|
| C101 | missing required section | add matching heading |
| C103 | missing title | add `# Title` |
| C201/C202 | order/interleaving | reorder sections |
| C206 | missing required field | add `- Label: value` |
| C207 | unexpected field (closed) | remove/rename |
| C301 | type mismatch | fix encoding |
| C302 | constraint violated | adjust value |
| C303/C304 | enum/const/union | choose allowed value |
| C50x/E001 | embed problems | fix fenced block/format/JSON |
| E410 | extension unavailable | report; needs plugin |

Encodings: booleans `true|false` lowercase · dates `YYYY-MM-DD` ·
datetime RFC 3339 · null = empty or `null` · numbers dot-decimal.

Authoring: fields are `Label: value` bullets; front matter is flat
`key: value` (NOT YAML — no `yes/on`, no anchors); tables bind
positionally to `table` declarations; fence info string must equal the
declared embed format; JSON embeds must be strict JSON.
