"""Dogfood check: every agent skill validates against skills.mds.

Anatomy: flat front-matter metadata (``name``, ``description``), an
identical "Resolve the CLI" section, and a per-skill "Workflow" section.
The canonical sources are ``skills/<name>.md`` (complete,
self-contained); ``tools/gen-skills.mjs`` deploys them verbatim to every
discovery/packaged target. The "Resolve the CLI" text's canonical copy
lives in the contract's own ``expect:`` block under its ``resolution``
declaration, and every source must match it byte-for-byte. Mirrors
``js/test/skills.test.js``.
"""

from pathlib import Path

from mds.validate import validate_files

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "skills" / "skills.mds"
SOURCES = sorted(p for p in (ROOT / "skills").glob("*.md"))
TEMPLATES = sorted((ROOT / "js" / "skills").glob("*.md"))
PY_TEMPLATES = sorted((ROOT / "py" / "mds" / "skills").glob("*.md"))


def _resolve_expect():
    import re

    text = CONTRACT.read_text(encoding="utf-8")
    m = re.search(
        r'^## "Resolve the CLI"[^\n]*\n\nexpect:\n((?: {2}[^\n]*\n)+)',
        text, re.M)
    assert m, "contract lost its Resolve-the-CLI expect block"
    return re.sub(r"^ {2}", "", m.group(1), flags=re.M).rstrip()


def _resolve_section(text):
    start = text.index("## Resolve the CLI")
    end = text.index("## Workflow")
    return text[start:end].rstrip()


def test_all_sources_and_templates_match_contract():
    assert len(SOURCES) == 4 and len(TEMPLATES) == len(PY_TEMPLATES) == 8
    for doc in [*SOURCES, *TEMPLATES, *PY_TEMPLATES]:
        r = validate_files(str(doc), str(CONTRACT))
        assert r["exitCode"] == 0, f"{doc.name}:\n{r['stream']}"


def test_resolve_section_equals_contract_expect_everywhere():
    expect = _resolve_expect()
    for doc in SOURCES:
        assert _resolve_section(doc.read_text(encoding="utf-8")) == expect, \
            f"{doc.name} resolve section drifted from skills.mds expect"


def test_generated_copies_match_sources():
    for source in SOURCES:
        expected = source.read_text(encoding="utf-8")
        for agent in (".claude", ".hermes", ".kilo"):
            generated = (ROOT / agent / "skills" / source.stem /
                         "SKILL.md").read_text(encoding="utf-8")
            assert generated == expected, f"{agent}: {source.name}"
        for templates in (TEMPLATES, PY_TEMPLATES):
            for agent in ("claude", "hermes"):
                packaged = next(p for p in templates if p.name ==
                                f"{agent}-SKILL-{source.stem.removeprefix('mds-')}.md")
                assert packaged.read_text(encoding="utf-8") == expected, packaged.name
