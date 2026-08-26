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
TODO_RE = re.compile(
    r"^(\s*)TODO: describe what the (.+) (section must convey|(\w+) must show)\.$", re.M)


def _fill_todo(schema_text: str) -> str:
    def repl(m: re.Match) -> str:
        label, kind, noun = m.group(2), m.group(3), m.group(4)
        if kind == "section must convey":
            text = CANNED.get(label, f"The {label} section states its key facts concisely.")
        else:
            text = f"The {noun} shows the content this document requires."
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
    # exact titles print their literal text; only glob titles scaffold a
    # `<Title>` placeholder — drafts always derive exact titles now
    if title is not None:
        assert title["text"] in skel, "roundtrip lost the document title"

    flat = flatten_non_title(doc["sections"], title)
    tables = [t for s in flat for t in s["tables"]]
    if tables:
        cols = " | ".join(tables[0]["columns"])
        assert f"| {cols} |" in skel, "roundtrip lost table columns"

    langs = [f["lang"] for s in flat for f in s["fences"]]
    for lang in langs:
        assert f"```{lang}" in skel, f"roundtrip lost {lang} embed"

    assert "..." in skel, "roundtrip lost prose placeholders"


def test_draft_gap_nullable():
    """Structural absence vs data absence (section 23.1): empty cells and
    empty field values are missing DATA, so the draft must emit
    ``nullable``, and its own self-check proves the contract accepts them.
    """
    gap_doc = """# G

## M

| A | B |
|---|---|
| 1 |   |
| 2 | 5 |

## F

- Age: 42
- Score:
"""
    gdraft = draft_schema(gap_doc, "gaps.md")
    assert gdraft["exitCode"] == 0, gdraft["stream"]
    assert re.search(r"^- B: integer nullable$", gdraft["schemaText"], re.M), \
        "empty column must be declared nullable"
    assert re.search(r"^- Score: string nullable$", gdraft["schemaText"], re.M), \
        "empty-only field must be declared nullable"
    assert re.search(r"^- A: integer$", gdraft["schemaText"], re.M), \
        "concrete column stays non-nullable"


def test_draft_defect_regressions():
    """Five draft defects pinned as regressions: multi-H1 titles, fenced
    example content, nested heading levels, ragged tables and emphasis
    wrapped bullet labels. Each document previously failed the self-check
    or produced wrong output.
    """
    # multi-H1: exact title, other H1s become top-level sections
    r = draft_schema(
        "# Report\n\n## Intro\n\nSome intro text here.\n\n"
        "# Appendix A\n\nAppendix prose.\n\n# Appendix B\n\nMore appendix prose.\n",
        "multi.md")
    assert r["exitCode"] == 0, r["stream"]
    assert re.search(r'^# "Report" as title required$', r["schemaText"], re.M)
    assert re.search(r"^# Appendix A required$", r["schemaText"], re.M)

    # fenced example content must not leak into structure
    fenced = ("# Doc\n\n## Real\n\nReal prose.\n\n```mds\n# Fake Heading\n\n"
              "- Fake: value\n\n| FakeCol |\n|---------|\n| x       |\n```\n")
    r = draft_schema(fenced, "fenced.md")
    assert r["exitCode"] == 0, r["stream"]
    assert "Fake" not in r["schemaText"]

    # nested subsections bind at their real heading level
    nested = "# Doc\n\n## Parent\n\nParent prose.\n\n### Child\n\nChild prose.\n"
    r = draft_schema(nested, "nested.md")
    assert r["exitCode"] == 0, r["stream"]
    assert re.search(r"^### Child required$", r["schemaText"], re.M)

    # ragged tables create no phantom column
    ragged = "# Doc\n\n## Data\n\n| A | B |\n|---|---|\n| 1 | 2 | extra |\n| 3 | 4 |\n"
    r = draft_schema(ragged, "ragged.md")
    assert r["exitCode"] == 0, r["stream"]
    assert not re.search(r"- : ", r["schemaText"])

    # emphasis-wrapped bullet labels become plain fields
    bold = "# Doc\n\n## Ext\n\n- **Formats**: embed svg and csv\n- Plain: value\n"
    r = draft_schema(bold, "bold.md")
    assert r["exitCode"] == 0, r["stream"]
    assert re.search(r"^- Formats: string$", r["schemaText"], re.M)

    # content order follows the document; non-expressible alternation
    # (prose-table-prose) leaves the section prose-unbound instead of
    # tripping C205
    order_doc = ("# Doc\n\n## Mixed\n\n| X | Y |\n|---|---|\n| 1 | 2 |\n\n"
                 "Table first prose after.\n\n## Alternating\n\nOpen prose.\n\n"
                 "| A |\n|---|\n| 1 |\n\nClosing prose.\n")
    r = draft_schema(order_doc, "order.md")
    assert r["exitCode"] == 0, r["stream"]
    mixed_tbl = r["schemaText"].find("table Mixed")
    mixed_prose = r["schemaText"].find("prose required minLength", mixed_tbl)
    assert mixed_tbl > -1 and mixed_prose > mixed_tbl, \
        "table must be declared before its trailing prose"
    assert not re.search(r"## Alternating required[\s\S]*?^prose ", r["schemaText"], re.M), \
        "alternating section stays prose-unbound"

    # emphasis-wrapped table headers become plain column names
    emph = ("# Doc\n\n## Matrix\n\n| *Structural* | **Data** |\n"
            "|--------------|----------|\n| a            | b        |\n")
    r = draft_schema(emph, "emph.md")
    assert r["exitCode"] == 0, r["stream"]
    assert re.search(r"^- Structural: string$", r["schemaText"], re.M)
    assert re.search(r"^- Data: string$", r["schemaText"], re.M)

    # every observed fence language binds as an embed WITH an expect stub —
    # diagrams, text blocks, unknown languages alike
    embed_doc = (
        "# Doc\n\n## Diagram\n\nSome context.\n\n```mermaid\nflowchart TD\n"
        "    A --> B\n```\n\n## Sometimes\n\nText only.\n\n## Always\n\nIntro.\n\n"
        "```mermaid\nflowchart LR\n    C --> D\n```\n\n```note\nsticky content\n```\n")
    r = draft_schema(embed_doc, "viz.md")
    assert r["exitCode"] == 0, r["stream"]
    assert re.search(r"^embed mermaid$", r["schemaText"], re.M), \
        "mermaid must be declared required (bare form)"
    assert not re.search(r"^embed mermaid optional$", r["schemaText"], re.M), \
        "mermaid appears in every occurrence of its sections"
    assert re.search(r"^embed note$", r["schemaText"], re.M), \
        "unknown fence languages bind presence too"
    assert re.search(
        r"embed mermaid\n\nexpect:\n {2}TODO: describe what the diagram must show\.",
        r["schemaText"]), "embed carries an expect stub"
    assert re.search(
        r"embed note\n\nexpect:[\s\S]*?validate:\n {2}semantic: optional",
        r["schemaText"]), "embed stubs bind semantic optional"

    # embeds pair POSITIONALLY: mixed-language sections emit one slot per
    # fence in document order; prose-fence-prose stays prose-unbound
    mixed = ("# Doc\n\n## Gallery\n\nIntro sentence.\n\n```mds\ndocument Example\n```\n\n"
             "Middle words.\n\n```text\nraw notes\n```\n\nClosing words.\n\n"
             "```mermaid\nflowchart TD\n    A --> B\n```\n")
    r = draft_schema(mixed, "mixed.md")
    assert r["exitCode"] == 0, r["stream"]
    slots = [r["schemaText"].find(p) for p in ("embed mds", "embed text", "embed mermaid")]
    assert all(i > -1 for i in slots) and slots[0] < slots[1] < slots[2], \
        "three embed slots in document order"
    assert "contract expects" not in r["schemaText"], "slot languages must match exactly"
    pep = ("# Doc\n\n## Wrapped\n\nBefore the block.\n\n```json\n{\"a\": 1}\n```\n\n"
           "After the block.\n")
    r = draft_schema(pep, "pep.md")
    assert r["exitCode"] == 0, r["stream"]
    assert not re.search(r"## Wrapped required[\s\S]*?^prose ", r["schemaText"], re.M), \
        "wrapped keeps embed, drops prose"
    assert re.search(r"^embed json$", r["schemaText"], re.M), \
        "wrapped keeps its json binding"


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
