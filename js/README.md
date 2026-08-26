# mds-core (JavaScript)

MDS — Markdown Document Schema: validate Markdown against `.mds` contracts from files, strings or streams with deterministic structure, types, constraints and LLM-readable semantic expectations.

## Install

```bash
npm i mds-core          # library + `mds` CLI
npx mds validate doc.md doc.mds
```

## Coding examples

```js
// Files
import { validateFiles } from 'mds-core';
const { exitCode, stream } = await validateFiles({ docPath: 'doc.md', schemaPath: 'doc.mds' });

// Strings
import { validateDocument } from 'mds-core';
const { exitCode, stream } = await validateDocument({ docText, schemaText });

// Streams
import { validateStreams } from 'mds-core';
import { Readable } from 'node:stream';
const { exitCode } = await validateStreams({
  docStream: Readable.from([docText]),
  schemaStream: Readable.from([schemaText])
});
```

## Skills for agents

```bash
npx --yes --package=mds-core mds skills install
```

This installs four skills for agent integration (Claude Code, Hermes, Kilo):

| Skill | Purpose |
|-------|---------|
| `mds-validate` | Validate a document against a contract, repair until clean |
| `mds-write` | Generate a document from a contract, then validate |
| `mds-draft` | Derive a starter contract from an existing document (`mds draft`) |
| `mds-install` | Resolve or install the `mds` CLI when none is available |

See the repository root README and the normative specification for details, the zero-config extension contract (`mds-ext-*` / `@mds/*`) and conformance fixtures.