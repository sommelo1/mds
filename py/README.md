# mds-core (Python)

MDS — Markdown Document Schema: reference validator, CLI and library.
Validates Markdown documents against `.mds` contracts with native semantic
expectations (`expect:`). Byte-identical to the npm package `mds-core` on
all conformance fixtures.

```bash
pip install mds-core        # or: pipx install mds-core (CLI only)
mds validate doc.md doc.mds
```

```python
from mds import validate_document

r = validate_document(doc_text=doc, schema_text=schema,
                      doc_name="doc.md", schema_name="doc.mds")
print(r["exitCode"], r["stream"])
```

See the repository root README and the normative specification for details,
the zero-config extension contract (`mds-ext-*` / entry-point group
`mds_ext`) and conformance fixtures.
