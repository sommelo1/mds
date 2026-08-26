---
name: mds-draft
description: "Turn an existing Markdown document into an MDS (.mds) contract via mds draft, fill the TODO expect stubs semantically, re-validate until clean, scaffold sanity check."
---

# MDS Draft — document to contract

## Resolve the CLI
Probe each candidate below with `mds help`; first match wins. If none
resolves, run the **mds-install** skill once, then continue here.
```text
mds …                                 global install (pipx / npm -g)
.venv\Scripts\python.exe -m mds …     Python venv, Windows
.venv/bin/python -m mds …             Python venv, POSIX
npx --yes --package=mds-core mds …    ad-hoc, needs Node >= 18 only
node js/bin/mds.js …                  inside this repository checkout
```


## Workflow

Begin by asking which files this run involves: the existing Markdown
document that should become a contract. Never guess paths; proceed only
once it is named.

Draft mechanically: `<mds> draft <doc.md> > <doc>.mds`. The CLI does the
mechanics; you do the semantics. The printed contract self-checks against
its source (exit 0); exit 1 means a broken draft — report it, do not
hand-tweak blindly.

Fill the TODOs semantically: for every `expect:` stub reading `TODO: …`,
write one to three plain sentences stating which content belongs there
and what must not appear. Keep the two-space indentation under `expect:`
exactly. You may loosen cards (`required` to `optional`) for sections
that are not always present; never invent sections the document does not
show.

Re-validate in the **mds-validate** loop until
`summary: 0 errors, 0 warnings`. A wrong expectation is fixed in the
expectation, never by editing the document.

Roundtrip sanity: `<mds> scaffold <doc>.mds` regenerates the skeleton;
every original heading must reappear, tables and embeds keep their shape.
Large deviations point at over-constrained declarations. For
interpretation while filling: repeated sections derive as `one-or-more`;
types come from concrete values only, so observed empty cells mark
declarations `nullable`, never `optional`; `prose minLength=N` reflects
observed text; every fence language binds as an embed carrying its own
`expect:` stub; nested subsections bind at their real heading level.
