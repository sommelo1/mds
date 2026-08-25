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

    # Recognition-only builtins: they identify fences but do not validate
    # syntax without optional libraries (deterministic default behavior).
    def recognize(fmt_id, aliases=None):
        return {"id": fmt_id, "aliases": aliases or [], "capabilities": {"syntax": False}}

    out = [
        json_fmt,
        recognize("yaml"),
        recognize("xml"),
        recognize("mermaid"),
        recognize("latex"),
        recognize("sql"),
        recognize("markdown", ["md"]),
    ]
    return out
