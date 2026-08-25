# MKS validate-and-repair

Validate and repair Markdown against an MKS (.mks) contract using the
bundled reference validator.

Target: $ARGUMENTS — a document plus its schema (`mks <doc.md> <schema.mks>`).
If empty, search the workspace for recent `*.md` files with a matching
`*.mks`; ask only if ambiguous.

## Procedure

1. Resolve contract and document.
2. Run the validator from the repository root:

   ```bash
   node js/bin/mks.js validate "<doc>" "<schema>"
   ```

   Python alternative: `.venv/Scripts/python.exe -m mks validate ...`
   Exit codes: 0 valid - 1 invalid - 2 schema/config broken.

3. Read the diagnostic stream. One finding per line, a Markdown list item:

   `- CODE severity /Path file:line:col [contract schema.mks:N] message`

   Indentation marks embedding depth. The final line is always
   `summary: N errors, M warnings` - treat it as ground truth.

4. Fix findings cheapest-first: structural codes (MKS-C1xx/C2xx) before
   value-level codes (MKS-C3xx); embed findings (MKS-C5xx, MKS-E*) at their
   reported location. Exit code 2 means the `.mks` itself is broken
   (codes MKS-C0xx/C4xx): fix the schema, never paper over it in the document.

5. Re-run until `summary: 0 errors, 0 warnings`, then stop. Do not edit
   beyond what the contract requires.

## Fast reference

- Missing section: add heading with the declared label (or matching `"*"` pattern).
- MKS-C206: add bullet `- Label: value` in that section.
- MKS-C301: check encoding - booleans lowercase true/false, dates YYYY-MM-DD,
  numbers with dot; empty/null only where typed.
- Front matter is flat `key: value`, NOT YAML (no yes/on coercion, no anchors).
- Fence info string must equal the declared embed format; JSON embeds strict.
- MKS-E410 = missing validator extension: report it, do not fake validity.
