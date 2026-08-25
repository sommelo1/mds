"""End-to-end roundtrip test for the experimental draft workflow.

``md --(draft)--> mds --(fill TODOs, as an agent would)--> mds'
   --(validate)--> clean --(scaffold)--> md-skeleton ~= original``

The "fill" step mechanizes exactly what the ``mds-draft`` skill instructs,
so the full lifecycle runs deterministically without invoking an LLM.

Mirrors ``js/test/draft.e2e.test.js``.
"""

import re
from pathlib import Path

from mds.draft import draft_schema
from mds.introspect import scaffold_doc
from mds.mddoc import parse_document
from mds.validate import validate_document

ROOT = Path(__file__).resolve().parents[2]
DOC_PATH = ROOT / "examples" / "draft-roundtrip.md"

CANNED = {
    "Summary": "States release date, downtime, latency effect and cost effect of the quarter.",
    "Owner": "Names the owning team, its lead and the team size plus on-call duty.",
    "Highlights": "Lists two to four concrete achievements of the quarter as short bullets.",
    "Metrics": "Reports latency, availability and deploy frequency with units; empty notes allowed.",
    "Incident Example": "Describes one past incident with cause and the fix that followed.",
    "Appendix Config": "Shows the production region and replica configuration as strict JSON.",
}
TODO_RE = re.compile(r"^(\s*)TODO: describe what the (.+) section must convey\.$", re.M)


def _fill_todo(schema_text: str) -> str:
    def repl(m: re.Match) -> str:
        label = m.group(2)
        text = CANNED.get(label, f"The {label} section states its key facts concisely.")
        return f"{m.group(1)}{text}"

    return TODO_RE.sub(repl, schema_text)


def test_draft_e2e():
    doc_text = DOC_PATH.read_text(encoding="utf-8")

    draft = draft_schema(doc_text, "draft-roundtrip.md")
    assert draft["exitCode"] == 0, draft["stream"]
    assert re.search(r"^ {2}TODO: describe what the .+ section must convey\.$",
                     draft["schemaText"], re.M), "draft must emit expect TODO stubs"

    filled = _fill_todo(draft["schemaText"])
    assert "TODO:" not in filled, "agent fill must replace all TODOs"

    reval = validate_document(
        doc_text=doc_text, doc_name="draft-roundtrip.md",
        schema_text=filled, schema_name="draft-roundtrip.mds",
        base_dir=str(ROOT), max_diagnostics=None, enable_optional_libs=False,
    )
    assert reval["exitCode"] == 0, reval["stream"]

    skel = scaffold_doc(filled, "draft-roundtrip.mds", str(ROOT))["stream"]
    doc = parse_document(doc_text)
    title = doc["title"]
    labels = [
        s["label"] for s in flatten_non_title(doc["sections"], title)
    ]
    missing = [l for l in labels if f"## {l}" not in skel]
    assert missing == [], f"roundtrip lost section titles: {missing}"
    if title is None:
        pass
    else:
        assert "<Title>" in skel, "roundtrip lost the title placeholder"

    flat = flatten_non_title(doc["sections"], title)
    tables = [t for s in flat for t in s["tables"]]
    if tables:
        cols = " | ".join(tables[0]["columns"])
        assert f"| {cols} |" in skel, "roundtrip lost table columns"

    langs = [f["lang"] for s in flat for f in s["fences"]]
    for lang in langs:
        assert f"```{lang}" in skel, f"roundtrip lost {lang} embed"

    assert "..." in skel, "roundtrip lost prose placeholders"


def flatten_non_title(sections, title):
    """Flatten the section tree, skipping the title section itself."""
    out = []

    def walk(items):
        for s in items:
            if title is not None and s["level"] == 1 and s["line"] == title["line"]:
                walk(s["children"])
                continue
            out.append(s)
            walk(s["children"])

    walk(sections)
    return out
