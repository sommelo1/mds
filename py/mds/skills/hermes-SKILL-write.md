---
name: mds-write
description: "Generate a Markdown document from scratch that satisfies an MDS (.mds) contract, then validate and repair in a loop until clean."
---

# MDS Write — generate a document against a contract

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

Begin by asking which files this run involves: the `.mds` contract to
satisfy and where the new Markdown document should be written. Never
guess paths; proceed only once both are named.

Read the contract fully before writing anything. Heading lines declare
sections with their cardinality (`required`, `optional`,
`one-or-more`); `prose`, `table`, `list`, field and `embed` declarations
bind the content each section shows; every `expect:` block states what
content belongs in its region.

Write the document satisfying every declaration: exact headings,
declared content kinds per section, correctly typed field, table and
list values, fences tagged with the declared format (`json`, `mermaid`,
and so on). Treat each `expect:` text as your writing brief for that
region.

Validate with the **mds-validate** loop: exit 0 done, exit 1 repair the
document cheapest-first, exit 2 report a broken schema — never weaken
the contract just to pass. Open world is the default: regions the
contract does not declare are free, so do not pad the document with
sections nobody asked for.
