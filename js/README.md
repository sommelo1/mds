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

See the repository root README and the normative specification for details, the zero-config extension contract (`mds-ext-*` / `@mds/*`) and conformance fixtures.