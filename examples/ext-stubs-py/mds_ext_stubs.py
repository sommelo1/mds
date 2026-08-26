"""Stub pack demonstrating the zero-config format-extension interface
(``mds_ext`` entry-point group) for embed types in GitHub/GitLab Flavored
Markdown. Zero-config install: ``pip install ./examples/ext-stubs-py``.

Note: Core already ships super-minimal sanity checks for math, mermaid,
plantuml, abc, csv, geojson, topojson and stl (findings as MDS-C504,
spec section 40.1). This pack intentionally overlaps on those ids:
plugins override built-ins of the same id, so installing it swaps core's
minimal checks for whatever is implemented here. ``toml`` and ``ini``
are purely additive recognition-only stubs.

Binding model (unchanged from core):
- ``embed <id>``           binds by id/alias, recognition-only suffices
- ``validation: required`` needs ``capabilities["syntax"] is True``,
    otherwise MDS-E410 -- that is the deliberate gap stubs leave open.

Upgrade path: replace a stub below with a real ``syntaxCheck`` and flip
``capabilities["syntax"]`` to ``True``. ``csv`` is the worked reference: a
deterministic, dependency-free column-count validator (~20 lines); deeper
validation than core's minimal checks is exactly what extensions are for.

Mirrors ``examples/ext-stubs-js/index.js``.
"""


def csv_syntax_check(content):
    """Reference implementation -- smallest useful validator.

    Naive comma split (quoted commas unsupported; see README limitations).
    ``relLine`` is 1-based within the fenced content, matching the core's
    forwarding convention (``startLine + relLine``).
    """
    rows = []
    raw_lines = content.split("\n")
    for i, line in enumerate(raw_lines):
        if line.strip() != "":
            rows.append({"i": i, "line": line})
    if not rows:
        return None
    want = len(rows[0]["line"].split(","))
    for row in rows[1:]:
        got = len(row["line"].split(","))
        if got != want:
            return {"relLine": row["i"] + 1,
                    "message": f"expected {want} columns, found {got}"}
    return None


def _stub(sid, aliases=None):
    """Recognition-only placeholder -- swap for a real syntaxCheck later."""
    return {"id": sid, "aliases": aliases or [], "capabilities": {"syntax": False}}


id = "md-stubs"

formats = [
    {
        "id": "csv",
        "aliases": ["tsv"],
        "findingCode": "MDS-E202",
        "capabilities": {"syntax": True},
        "syntaxCheck": csv_syntax_check,
    },
    _stub("math", ["tex"]),
    _stub("plantuml", ["puml"]),
    _stub("geojson"),
    _stub("topojson"),
    _stub("stl"),
    _stub("abc"),
    _stub("toml"),
    _stub("ini", ["properties"]),
]
