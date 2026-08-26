---
name: mds-validate
description: "Validate a Markdown document against an MDS (.mds) contract with the mds CLI and repair failures by looping until the summary reports zero errors and zero warnings."
---

# MDS Validate — run the validator, repair, repeat

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

Begin by asking which files this run involves: the Markdown document and
its `.mds` contract. Never guess paths; proceed only once both are named.

Run `<mds> validate <doc.md> <doc.mds>` and act on the exit code. Exit 0
means done; the last line must read `summary: 0 errors, 0 warnings`.

Exit 1 means the document violates a valid contract. Fix the document,
cheapest-first: structural findings (MDS-C1xx/C2xx) before value findings
(C3xx and later). Every diagnostic line names semantic path, document
location, contract line and the concrete problem, so follow it literally.
Never invent data to silence a finding. When a message hints at declaring
`nullable`, that one fix belongs in the contract instead.

Exit 2 means the contract itself is broken (MDS-C0xx/C4xx): fix the
`.mds`, never the document.

Re-run until exit 0. Diagnostics arrive as one Markdown list item per
finding, two spaces of indentation per embed depth; the final `summary:`
line is authoritative. Normative background when needed: spec Annex D
(code registry) and section 23.1 (`optional` versus `nullable`).

A clean summary only proves the mechanical contract; Core never
evaluates `expect:` on its own. Close that gap yourself before calling
the document done: walk through every `expect:` block in the contract,
locate its region in the document, and judge whether the region really
conveys what the expectation demands — content present, required facts
and units included, placeholders such as TODO or TBD gone. Repair
mismatches by improving the region and re-running the loop. Never
invent facts to satisfy an expectation, and when an expectation is
wrong for the task at hand, correct the expectation instead of padding
the document.


