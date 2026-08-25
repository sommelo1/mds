# mds-core (JavaScript)

MDS — Markdown Document Schema: reference validator, CLI and library.
Validates Markdown documents against `.mds` contracts with native semantic
expectations (`expect:`).

```bash
npm i mds-core          # library + `mds` CLI
npx mds validate doc.md doc.mds
```

```js
import { validateDocument } from 'mds-core';
const { exitCode, stream } = await validateDocument({ docText, schemaText });
```

See the repository root README and the normative specification
(`mds - Markdown Schema.md`) for details, extension contract and conformance
fixtures. The Python implementation on PyPI (`pip install mds-core`) is
byte-identical on all fixtures.
