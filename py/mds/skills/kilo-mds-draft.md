# MDS draft roundtrip

Derive a starter MDS (.mds) contract from an existing Markdown document,
fill the semantic TODO stubs, then re-validate.

Target: $ARGUMENTS — a Markdown document (`mds draft <doc.md> > <doc>.mds`).
If empty, ask for the document path.

## Procedure

1. Mechanical draft from the repository root:

   ```bash
   node js/bin/mds.js draft "<doc.md>" > "<doc>.mds"
   ```

   Python alternative: `.venv/Scripts/python.exe -m mds draft ...`
   Exit 0 means the generated contract already validates the source.
   Exit 1 + stderr diagnostics = broken draft: report it, do not tweak.

2. Read the source document section by section and replace every line

   `TODO: describe what the <X> section must convey.`

   under an `expect:` block with 1-3 plain sentences about required facts,
   units, audience and tone of that section. Keep the two-space indentation.
   You may loosen `required` to `optional`; never invent sections.

3. Validate until clean:

   ```bash
   node js/bin/mds.js validate "<doc.md>" "<doc>.mds"
   ```

   Fix cheapest-first; final line must read `summary: 0 errors, 0 warnings`.

4. Roundtrip sanity check: `node js/bin/mds.js scaffold "<doc>.mds"` should
   regenerate every original heading with tables/embeds intact; large
   deviations mean over-constrained declarations - loosen them.

## Fast reference

- `minLength=N` on prose derives from the observed text; relax when future
  documents may be shorter.
- `validate:` / `semantic: optional` keeps expectations inert until a
  semantic extension enforces them.
- Repeated sections become `<label> one-or-more`; singletons stay
  `required`.
- Nested subsections are skipped by the draft and remain legal through the
  default-open contract.
