---
name: mds-install
description: "Exceptional path used only when another mds skill cannot resolve the mds CLI. Probe installations, detect the project runtime, install mds-core persistently, verify, then hand back."
---

# MDS Install — make the validator available

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

Use this skill only when **mds-validate**, **mds-write** or **mds-draft**
report no usable CLI. Never preempt them.

Probe before installing anything; any success ends this skill. Try each
candidate from the resolution ladder above with `mds help`, note which
invocation worked, and hand that exact invocation back to the caller.

When nothing resolves, detect the project language: `package.json` or
`node_modules` indicates Node; `pyproject.toml`, `requirements.txt` or a
`.venv` directory indicates Python; neither present means prefer whatever
toolchain exists (pipx, or Node 18 or later).

Install persistently. Python: `pipx install mds-core`, falling back to
`python -m pip install --user mds-core`. Node: `npm i -g mds-core`. Both
builds are dependency-free; no other packages are needed.

Verify with `mds help` exiting 0, state the invocation the calling skill
should use, and return to it. Inside this repository checkout no install
is ever needed.
