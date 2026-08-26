# mds-core (Python)

MDS — Markdown Document Schema: validate Markdown against `.mds` contracts from files, strings or streams with deterministic structure, types, constraints and LLM-readable semantic expectations.

## Install

```bash
pip install mds-core        # or: pipx install mds-core (CLI only)
mds validate doc.md doc.mds
```

## Coding examples

```python
# Files
from mds import validate_files
r = validate_files("doc.md", "doc.mds")
print(r["exitCode"], r["stream"])

# Strings
from mds import validate_document
r = validate_document(doc_text=doc, schema_text=schema, doc_name="doc.md", schema_name="doc.mds")
print(r["exitCode"], r["stream"])

# Streams
import io
from mds import validate_streams
r = validate_streams(io.StringIO(doc_text), io.StringIO(schema_text))
print(r["exitCode"], r["stream"])
```

## Skills for agents

```bash
mds skills install
```

See the repository root README and the normative specification for details, the zero-config extension contract (entry-point group `mds_ext`) and conformance fixtures.