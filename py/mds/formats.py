"""Bundled format extensions.

Built-ins implement exactly the same interface as drop-in plugins
(``mds-ext-*`` npm packages / ``mds_ext`` entry points), so the plugin
registry treats them uniformly (sections 38-40).

Optional third-party validators (ajv, jsonschema, yaml libs) are only
activated when ``enable_optional_libs`` is true - the default builds stay
dependency-free and fully deterministic (AGENTS rule 5).

Mirrors ``js/src/formats/index.js`` statement by statement.
"""

import re


def json_syntax_error_line(s):
    """Strict, tiny JSON syntax checker shared by both reference
    implementations line-for-line so parse positions never diverge.

    Returns 0 when valid, otherwise the 1-based line offset inside the
    fenced block of the first failing character.
    """
    i = 0
    n = len(s)

    def ws():
        nonlocal i
        while i < n:
            c = s[i]
            if c in (" ", "\t", "\r", "\n"):
                i += 1
            else:
                break

    def fail():
        line = 1
        for k in range(min(i, n)):
            if s[k] == "\n":
                line += 1
        return line

    def str_():
        nonlocal i
        if s[i] != '"':
            return False
        i += 1
        while i < n:
            c = s[i]
            if c == "\\":
                i += 2
                continue
            if c == '"':
                i += 1
                return True
            if c == "\n":
                return False
            i += 1
        return False

    def num():
        nonlocal i
        m = re.match(r"-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?", s[i:])
        if not m or m.group(0) == "":
            return False
        i += len(m.group(0))
        return True

    def lit():
        nonlocal i
        for w in ("true", "false", "null"):
            if s.startswith(w, i):
                i += len(w)
                return True
        return False

    def value():
        nonlocal i
        ws()
        if i >= n:
            return False
        c = s[i]
        if c == "{":
            i += 1
            ws()
            if s[i] == "}":
                i += 1
                return True
            while True:
                ws()
                if not str_():
                    return False
                ws()
                if s[i] != ":":
                    return False
                i += 1
                if not value():
                    return False
                ws()
                if s[i] == ",":
                    i += 1
                    continue
                if s[i] == "}":
                    i += 1
                    return True
                return False
        if c == "[":
            i += 1
            ws()
            if s[i] == "]":
                i += 1
                return True
            while True:
                if not value():
                    return False
                ws()
                if s[i] == ",":
                    i += 1
                    continue
                if s[i] == "]":
                    i += 1
                    return True
                return False
        if c == '"':
            return str_()
        if c == "-" or "0" <= c <= "9":
            return num()
        return lit()

    if not value():
        return fail()
    ws()
    if i != n:
        return fail()
    return 0


def builtin_formats(enable_optional_libs=False):
    """Construct the built-in format extension descriptors."""
    del enable_optional_libs  # reserved for ajv/jsonschema/yaml integration

    def _json_check(content):
        rel = json_syntax_error_line(content)
        return None if rel == 0 else {"relLine": rel, "message": "invalid JSON syntax"}

    json_fmt = {
        "id": "json",
        "aliases": ["jsonc"],
        "capabilities": {"syntax": True},
        "syntaxCheck": _json_check,
    }

    def _finding(rel_line, message):
        return {"relLine": rel_line, "message": message}

    def _content_lines(content):
        raw = [line.rstrip() for line in str(content).splitlines()]
        rows = [{"text": text, "ix": ix + 1} for ix, text in enumerate(raw)
                if text.strip() != ""]
        return raw, rows

    _MERMAID_KINDS = ("graph", "flowchart", "sequenceDiagram", "classDiagram",
                      "stateDiagram", "erDiagram", "journey", "gantt", "pie",
                      "mindmap", "timeline", "quadrantChart", "gitGraph",
                      "requirementDiagram", "C4Context", "sankey-beta",
                      "xychart-beta")

    def _math_check(content):
        _, rows = _content_lines(content)
        if not rows:
            return _finding(1, "empty math block")
        if str(content).count("$") % 2 != 0:
            return _finding(rows[0]["ix"], "unbalanced math delimiters ($)")
        return None

    def _mermaid_check(content):
        _, rows = _content_lines(content)
        if not rows:
            return _finding(1, "empty mermaid block")
        first = rows[0]["text"].strip()
        if not any(first.startswith(k) for k in _MERMAID_KINDS):
            return _finding(rows[0]["ix"], "unknown mermaid diagram type")
        return None

    def _plantuml_check(content):
        _, rows = _content_lines(content)
        if not rows or rows[0]["text"].strip() != "@startuml":
            return _finding(rows[0]["ix"] if rows else 1, "missing @startuml")
        if rows[-1]["text"].strip() != "@enduml":
            return _finding(rows[-1]["ix"], "missing @enduml")
        return None

    def _abc_check(content):
        _, rows = _content_lines(content)
        if not rows or not re.match(r"^X:\s*\d+", rows[0]["text"].strip()):
            return _finding(rows[0]["ix"] if rows else 1,
                            "abc must begin with an X: index field")
        return None

    def _csv_check(content):
        raw, _rows = _content_lines(content)
        rows = [line for line in raw if line.strip() != ""]
        if not rows:
            return _finding(1, "empty csv block")
        header_cols = len(rows[0].split(","))
        for i in range(1, len(rows)):
            n = len(rows[i].split(","))
            if n != header_cols:
                return _finding(i + 1, f"row {i + 1} has {n} fields, expected {header_cols}")
        return None

    def _stl_check(content):
        _, rows = _content_lines(content)
        if not rows or not re.match(r"^solid\b", rows[0]["text"].strip(), re.I):
            return _finding(rows[0]["ix"] if rows else 1, 'stl must start with "solid"')
        if not re.match(r"^endsolid\b", rows[-1]["text"].strip(), re.I):
            return _finding(rows[-1]["ix"], 'stl must end with "endsolid"')
        return None

    def _json_typed(pattern, message):
        def check(content):
            rel = json_syntax_error_line(content)
            if rel != 0:
                return {"relLine": rel, "message": "invalid JSON syntax"}
            if not re.search(pattern, str(content)):
                return _finding(1, message)
            return None
        return check

    # Lightweight validators for formats GitHub and GitLab render natively:
    # deterministic, dependency-free checks; findings surface as MDS-C504.
    def light504(fmt_id, aliases, check):
        return {"id": fmt_id, "aliases": aliases, "capabilities": {"syntax": True},
                "findingCode": "MDS-C504", "syntaxCheck": check}

    # Recognition-only builtins: they identify fences but do not validate
    # syntax without optional libraries (deterministic default behavior).
    def recognize(fmt_id, aliases=None):
        return {"id": fmt_id, "aliases": aliases or [], "capabilities": {"syntax": False}}

    out = [
        json_fmt,
        light504("math", ["latex", "tex"], _math_check),
        light504("mermaid", [], _mermaid_check),
        light504("plantuml", ["puml"], _plantuml_check),
        light504("abc", [], _abc_check),
        light504("csv", [], _csv_check),
        light504("geojson", [],
                 _json_typed(r'"type"\s*:\s*"(Point|MultiPoint|LineString|MultiLineString'
                             r'|Polygon|MultiPolygon|GeometryCollection|Feature|FeatureCollection)"',
                             "not a GeoJSON object")),
        light504("topojson", [],
                 _json_typed(r'"type"\s*:\s*"Topology"', "not a Topology object")),
        light504("stl", [], _stl_check),
        recognize("yaml"),
        recognize("xml"),
        recognize("sql"),
        recognize("markdown", ["md"]),
        recognize("svg"),
    ]
    return out
