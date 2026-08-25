"""Example zero-config MDS format extension (Python).

Install into the project environment (``pip install ./examples/ext-svg-py``);
the ``mds_ext`` entry point makes ``embed svg …`` statements resolve here.
Same descriptor interface as the bundled formats (AGENTS rule 4).

Binding: any `.mds` statement ``embed svg`` (alias ``svglite``) resolves
here; ``validation: required`` without this package yields MDS-E410.
"""


def _syntax_check(content):
    """Minimal sanity check: non-empty lines outside `</svg>` start with `<`.

    Returns ``{"relLine": int, "message": str}`` or ``None``.
    """
    for i, line in enumerate(content.split("\n")):
        t = line.strip()
        if t != "" and t != "</svg>" and not t.startswith("<"):
            return {"relLine": i, "message": "invalid SVG element"}
    return None


id = "svg"

formats = [{
    "id": "svg",
    "aliases": ["svglite"],
    "findingCode": "MDS-E201",
    "capabilities": {"syntax": True},
    "syntaxCheck": _syntax_check,
}]
