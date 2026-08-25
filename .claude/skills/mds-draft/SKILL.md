---
name: mds-draft
description: >
  Turn an existing Markdown document into a starter MDS (.mds) contract:
  mechanical draft via the mds CLI, then replace the TODO expect stubs with
  real semantic expectations, then re-validate until clean. Includes the
  roundtrip sanity check (draft, fill, validate, scaffold).
---

# MDS Draft — document to contract

Derive a tweakable `.mds` contract from a Markdown document you already
have. The CLI does the mechanics; you do the semantics.

## Workflow

1. Draft (mechanical):

   ```bash
   node js/bin/mds.js draft <doc.md> > <doc>.mds      # repository checkout
   # npx --yes --package=mds-core mds draft <doc.md> > <doc>.mds
   # mds draft <doc.md> > <doc>.mds                   # after install
   ```

   The command self-checks: the printed contract already validates the
   source document (exit 0). Exit 1 plus stderr diagnostics means the draft
   itself is broken - report it instead of hand-tweaking blindly.

2. Fill the TODOs (semantic). Read the source document section by section.
   For every block shaped like:

   ```mds
   expect:
     TODO: describe what the Notes section must convey.
   ```

   replace the TODO line with 1-3 plain sentences stating which content
   belongs there and what must not (required facts, units, audience, tone).
   Keep the two-space indentation under `expect:` exactly. While editing you
   may loosen cards (`required` to `optional`) for sections that are not
   always present; never invent sections the document does not show.

3. Re-validate (mechanical):

   ```bash
   node js/bin/mds.js validate <doc.md> <doc>.mds
   ```

   Fix findings cheapest-first (structural codes before value codes) and
   repeat until `summary: 0 errors, 0 warnings`. Never edit the document to
   satisfy a wrong expectation - fix the expectation.

4. Roundtrip sanity check. Regenerate the skeleton from the finished
   contract and compare it against the original document:

   ```bash
   node js/bin/mds.js scaffold <doc>.mds
   ```

   Every original heading should reappear; tables and embeds keep their
   shape. Large deviations point at over-constrained declarations.

## Notes

- Derived `minLength=` values come from the observed text; relax them when
  future documents may be shorter.
- `validate:` blocks default to `semantic: optional`, so expectations stay
  inert until a semantic extension enforces them.
- Nested `###` subsections are skipped by the draft; the open contract keeps
  them legal. Declare them manually when they matter.
