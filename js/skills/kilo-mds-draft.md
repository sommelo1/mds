# MDS Draft — document to contract

Target: $ARGUMENTS.

Derive a tweakable `.mds` contract from a Markdown document you already
have. The CLI does the mechanics; you do the semantics.

## Running the CLI (any platform)

Resolve the `mds` command once per session; first match wins:

1. `mds --version` succeeds → use `mds …` (pipx or npm global install).
2. A `.venv` exists in the workspace →
   - Windows: `.venv\Scripts\python.exe -m mds …`
   - POSIX: `.venv/bin/python -m mds …`
3. Otherwise use `npx --yes --package=mds-core mds …` (Node ≥ 18).

Inside this repository checkout `node js/bin/mds.js …` always works.

## Workflow

1. Draft (mechanical):

   ```bash
   <mds> draft <doc.md> > <doc>.mds
   ```

   The command self-checks: the printed contract already validates the
   source document (exit 0), and a stderr hint reminds you of the next
   step. Exit 1 plus stderr diagnostics means the draft itself is broken —
   report it instead of hand-tweaking blindly.

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
   <mds> validate <doc.md> <doc>.mds
   ```

   Fix findings cheapest-first (structural codes before value codes) and
   repeat until `summary: 0 errors, 0 warnings`. Never edit the document to
   satisfy a wrong expectation — fix the expectation.

4. Roundtrip sanity check. Regenerate the skeleton from the finished
   contract and compare it against the original document:

   ```bash
   <mds> scaffold <doc>.mds
   ```

   Every original heading should reappear; tables and embeds keep their
   shape. Large deviations point at over-constrained declarations.

## What the draft derives

- Repeated sections become `<label> one-or-more`; singletons stay
  `required`.
- Empty cells and empty field values are treated as *data absence*, not
  structural absence: the draft infers types from concrete values only and
  marks such columns/fields `nullable` — never `optional`.
- `prose minLength=N` comes from the observed text of each occurrence;
  relax it when future documents may be shorter.
- Field and table-column types are inferred from observed values; an empty
  cell anywhere makes that column optional.
- Only `json` fences are declared as `embed json`; other fence languages
  stay undeclared and remain legal through the default-open contract.
- Nested subsections are skipped; expectations bind `semantic: optional`,
  so they stay inert until a semantic extension enforces them.

Installing these instructions into another project: run `mds skills install`
there — see README → Agent skills.

