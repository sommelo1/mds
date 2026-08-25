"""Example semantic-validation extension (Python) -- the rule-based
reference implementation for section 21 bindings.

Install into the project environment (``pip install
./examples/ext-sem-rule-py``). Core only knows that a semantic expectation
exists and whether evaluation is required; THIS package decides what
"semantically acceptable" means:

- a region whose text is thinner than its expectation demands
- leftover placeholders (TBD)

Interface contract (mirrors format descriptors):
``validators: [{"id", "findingCode", "validateExpect"}]`` where
``validateExpect({"path", "expect", "text"})`` returns ``[{"message"}]``
findings that Core renders as ``MDS-E4xx`` lines.

Mirrors ``examples/ext-sem-rule-js/index.js`` byte-for-byte in messages.
"""

import re


def _validate_expect(r):
    out = []
    trimmed = str(r.get("text") or "").strip()
    if len(trimmed) < 20:
        out.append({
            "message": f'region "{r["path"]}" too thin for its expectation '
                       f'({len(trimmed)} chars)',
        })
    if re.search(r"\bTBD\b", trimmed):
        out.append({"message": f'region "{r["path"]}" still contains TBD'})
    return out


id = "sem-rule"

validators = [{
    "id": "rule",
    "findingCode": "MDS-E450",
    "validateExpect": _validate_expect,
}]
