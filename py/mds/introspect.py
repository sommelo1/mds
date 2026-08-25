"""Introspection and generation over schema contracts (sections 47/48):
machine-readable inspection reports and Markdown skeleton generation.

Pure library functions - no argv handling, no console I/O. The CLI
(:mod:`mds.cli`) is a thin wrapper around these plus :mod:`mds.validate`.

Mirrors ``js/src/introspect.js``.
"""

from .validate import load_schema


def _render_expect(out, indent, text):
    if not text:
        return
    out.append(f"{indent}- expect:")
    for line in str(text).split("\n"):
        out.append(f"{indent}      {line}")


def _render_validate(out, indent, holder):
    """Render a region's validate binding, if any."""
    vs = holder.get("validateSem")
    if not vs:
        return
    out.append(f"{indent}- validate semantic: {vs['semantic']}")


def inspect_schema(schema_text, schema_name="schema.mds", base_dir="."):
    """Render an introspection report (Markdown list) for a schema.

    Returns ``{"exitCode": int, "stream": str}``.
    """
    loaded = load_schema(schema_text, schema_name, base_dir)
    model, diags = loaded["model"], loaded["diags"]
    if any(d.severity == "error" for d in diags):
        return {"exitCode": 2, "stream": "\n".join(d.render() for d in diags)}
    out = []
    out.append(f"- document: {model['documentName'] or '(unnamed)'}")
    out.append(f"- order: {model['orderMode']}")
    out.append(f"- additionalSections: {str(model['additionalSections']).lower()}")
    out.append(f"- additionalFields: {str(model['additionalFields']).lower()}")
    _render_expect(out, "", model.get("expect"))
    _render_validate(out, "", model)

    def walk(heads, indent):
        for h in heads:
            card = "" if h["card"] == "required" else f" [{h['card']}]"
            out.append(f"{indent}- ## {h['label']}{card}")
            _render_expect(out, f"{indent}  ", h.get("expect"))
            _render_validate(out, f"{indent}  ", h)
            if h.get("prose"):
                out.append(f"{indent}  - prose {h['prose']['card']}")
                _render_expect(out, f"{indent}    ", h["prose"].get("expect"))
                _render_validate(out, f"{indent}    ", h["prose"])
            if h.get("list"):
                tail = f"{indent}  - list {h['list']['typeExpr']} {h['list']['card']}".rstrip()
                out.append(tail)
                _render_expect(out, f"{indent}    ", h["list"].get("expect"))
                _render_validate(out, f"{indent}    ", h["list"])
            for t in h["tables"]:
                cols = ", ".join(c["label"] for c in t["cols"])
                out.append(f"{indent}  - table {t.get('name') or '(anon)'} ({cols})")
                _render_expect(out, f"{indent}    ", t.get("expect"))
                for c in t["cols"]:
                    if c.get("expect"):
                        out.append(f"{indent}    - column {c['label']}:")
                        _render_expect(out, f"{indent}      ", c.get("expect"))
            for e in h["embeds"]:
                out.append(f"{indent}  - embed {e['format']} {e['card']}")
                _render_expect(out, f"{indent}    ", e.get("expect"))
            for f in h["fields"]:
                tail = (f"{indent}  - field {f.get('id') or f['label']}: "
                        f"{f['typeExpr']} {f['card']}").rstrip()
                out.append(tail)
                _render_expect(out, f"{indent}    ", f.get("expect"))
            walk(h["children"], f"{indent}    ")

    walk(model["sections"], "")
    return {"exitCode": 0, "stream": "\n".join(out)}


def scaffold_doc(schema_text, schema_name="schema.mds", base_dir="."):
    """Generate a Markdown skeleton satisfying the section structure.

    Returns ``{"exitCode": int, "stream": str}``.
    """
    loaded = load_schema(schema_text, schema_name, base_dir)
    model, diags = loaded["model"], loaded["diags"]
    if any(d.severity == "error" for d in diags):
        return {"exitCode": 2, "stream": "\n".join(d.render() for d in diags)}
    out = []

    def walk(heads):
        for h in heads:
            out.append("")
            label = "<Title>" if h["glob"] else h["label"]
            out.append(f"{'#' * h['level']} {label}")
            out.append("")
            if h.get("prose"):
                out.append("...")
            if h.get("list"):
                out.append("- ...")
            for t in h["tables"]:
                out.append("")
                out.append("| " + " | ".join(c["label"] for c in t["cols"]) + " |")
                out.append("|" + "|".join("---" for _ in t["cols"]) + "|")
            for e in h["embeds"]:
                out.append("")
                out.append(f"```{e['format']}")
                out.append("...")
                out.append("```")
            for f in h["fields"]:
                if not f.get("children") and f["card"] != "zero-or-more":
                    out.append(f"- {f['label']}: ")
            walk(h["children"])

    walk(model["sections"])
    return {"exitCode": 0, "stream": "\n".join(out).lstrip("\n")}
