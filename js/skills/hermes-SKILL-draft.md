---
name: mds-draft
description: >
  Derive a starter MDS (.mds) contract from an existing Markdown document:
  mechanical `mds draft`, then replace TODO expect stubs with real semantic
  expectations, then re-validate. Best-effort adapter for Hermes-compatible
  skill loaders (same workflow as the Claude Code skill).
---

# MDS Draft — document to contract

CLI does the mechanics, you do the semantics.

1. Draft:

   ```bash
   node js/bin/mds.js draft <doc.md> > <doc>.mds
   # or: npx --yes --package=mds-core mds draft <doc.md> > <doc>.mds
   ```

   Exit 0 = the printed contract already validates the document. Exit 1 =
   broken draft; report instead of tweaking.

2. Fill TODOs: for every `expect:` block replace the
   `TODO: describe what the X section must convey.` line with 1-3 sentences
   on required facts/units/audience/tone for section X (read the source
   first). Keep the two-space indent. Loosening cards to `optional` is fine;
   inventing sections is not.

3. Re-validate until `summary: 0 errors, 0 warnings`:

   ```bash
   node js/bin/mds.js validate <doc.md> <doc>.mds
   ```

4. Roundtrip check: `node js/bin/mds.js scaffold <doc>.mds` - all original
   headings reappear, tables/embeds keep shape; deviations hint at
   over-constrained declarations.

Notes: `minLength=` comes from observed text (relax if needed);
expectations are inert until a semantic extension enforces them; nested
subsections are skipped by the draft and stay legal via the open contract.
