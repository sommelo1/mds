"""Experimental schema drafting: derive a starter ``.mds`` contract from an
existing Markdown document (inverse of :func:`mds.introspect.scaffold_doc`).

The draft reuses :func:`mds.mddoc.parse_document` so it sees the document
exactly as the validator does. Derived contracts are intentionally
conservative and deterministic: prose lengths come from the observed text,
``expect:`` blocks are TODO stubs bound ``semantic: optional``, and everything
left undeclared stays tolerated by the default-open contract
(``additionalSections`` / ``additionalFields``). The result is a starting
point for tweaking, never a finished specification.

Pure library function - no argv handling, no process I/O. Mirrors
``js/src/draft.js``.
"""

import os
import re

from .mddoc import flatten_sections, parse_document
from .validate import validate_document

_CARDS = ("required", "optional", "one-or-more", "zero-or-more")
_FIELD_MAX_LABEL = 48
_URLISH = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)

# Human noun per fence language for expect stubs (section 21).
_EMBED_NOUNS = {
    "mermaid": "diagram", "plantuml": "diagram", "puml": "diagram",
    "svg": "diagram", "abc": "score", "math": "formula", "latex": "formula",
    "tex": "formula", "csv": "table data", "json": "JSON document",
    "geojson": "map", "topojson": "map", "stl": "mesh", "markdown": "document",
}


def _embed_noun(lang):
    return _EMBED_NOUNS.get(lang, "content")
_RE_INT = re.compile(r"^[+-]?\d+$")
_RE_NUM = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$")
_RE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_RE_BOOL = re.compile(r"^(true|false)$")


def _prose_text(sec):
    """Join paragraphs the way the validator measures them."""
    return "\n\n".join(p["text"] for p in sec["paras"])


def _infer_type(values):
    """Guess the narrowest stable scalar type across all samples."""
    kinds = set()
    for v in values:
        if v == "":
            kinds.add("null")
        elif _RE_BOOL.match(v):
            kinds.add("boolean")
        elif _RE_INT.match(v):
            kinds.add("integer")
        elif _RE_NUM.match(v):
            kinds.add("number")
        elif _RE_DATE.match(v):
            kinds.add("date")
        else:
            kinds.add("string")
    kinds.discard("null")
    if not kinds:
        return "string"
    if len(kinds) == 1:
        return next(iter(kinds))
    if kinds & {"string", "boolean", "date"}:
        return "string"
    return "number"


def _clean_label(raw):
    """Strip surrounding emphasis/backticks from a bullet label."""
    return re.sub(r"[\*_`]{1,3}\s*$", "", re.sub(r"^\s*[\*_`]{1,3}", "", raw)).strip()


def _classify_bullets(items):
    """Split top-level bullets into field candidates and plain list items."""
    fields = []
    plain = []
    for b in items:
        text = b["text"]
        idx = text.find(":")
        ok_shape = 0 < idx <= _FIELD_MAX_LABEL and not _URLISH.match(text)
        label = _clean_label(text[:idx]) if ok_shape else ""
        if ok_shape and label != "" and ":" not in label \
                and label.lower() not in _CARDS:
            fields.append((label, text[idx + 1:].strip()))
        else:
            plain.append(b)
    return fields, plain


def _pascal(parts):
    """PascalCase identifier from free-form parts (document/table names)."""
    words = []
    for part in parts:
        for w in re.split(r"[^A-Za-z0-9]+", str(part)):
            if w:
                words.append(w[0].upper() + w[1:].lower())
    name = "".join(words)
    if name and name[0].isdigit():
        name = "Doc" + name
    return name or "Document"


def _safe_label(label):
    """Quote a heading label whenever its bare form could parse as grammar:
    cardinality keywords, the ``as`` identifier keyword, content-statement
    keywords or colon/quote characters."""
    reserved = set(_CARDS) | {"as", "table", "list", "prose", "embed"}
    risky = any(t.lower() in reserved for t in label.split()) \
        or bool(re.search(r'[:"]', label))
    return f'"{label}"' if risky else label


def _safe_title(label):
    """Quote a title label unconditionally: titles may contain anything."""
    return '"%s"' % label.replace("\\", "\\\\").replace('"', '\\"')


def draft_schema(doc_text, doc_name="doc.md"):
    """Derive a draft ``.mds`` contract from a document and self-check it.

    Returns ``{"schemaText": ..., "exitCode": ..., "stream": ...}`` where
    ``stream`` carries the internal self-check diagnostics (empty when valid).
    """
    doc = parse_document(doc_text)
    base = re.sub(r"\.[^.]*$", "", str(doc_name))
    out = []

    out.append(f"document {_pascal([base])}")
    if doc["title"]:
        # Exact title text, never a glob: a "*" title would claim every H1
        # in multi-chapter documents and starve all section declarations.
        out.append("")
        out.append(f'# {_safe_title(doc["title"]["text"])} as title required')

    # Declarations match instances of the SAME heading level anywhere in
    # the tree, so drafts emit the real marker level; key includes it.
    groups = {}
    order = []
    title_line = doc["title"]["line"] if doc["title"] else None
    for entry in flatten_sections(doc["sections"]):
        sec = entry["sec"]
        if sec["level"] == 1 and title_line is not None and sec["line"] == title_line:
            continue
        key = f'{sec["level"]}\x00{sec["label"].lower()}'
        if key not in groups:
            groups[key] = {"level": sec["level"], "label": sec["label"], "occ": []}
            order.append(key)
        groups[key]["occ"].append(sec)

    for key in order:
        g = groups[key]
        occ = g["occ"]
        n = len(occ)
        card = "required" if n == 1 else "one-or-more"
        out.append("")
        out.append(f'{"#" * g["level"]} {_safe_label(g["label"])} {card}')

        # positional content order (C205): C205 collapses all tables to one
        # rank class and all embeds to another, so binding is expressible iff
        # some subset of {prose, tables, embeds} appears in contiguous blocks
        # across EVERY occurrence. Try subsets in a preference ladder (tables
        # are the most structural binding); the first passing subset decides
        # what this section declares. Sections ending with the empty set bind
        # presence/fields/lists only — their block content stays tolerated
        # under additionalFields.
        def _kind_classes(s):
            out = []
            for b in s.get("blocks") or []:
                if b["kind"] == "para":
                    out.append("prose")
                elif b["kind"] == "fence":
                    out.append("embeds")
                elif b["kind"] == "table":
                    out.append("tables")
            return out

        def _contiguous_for(keep):
            for s in occ:
                pos = {}
                i = 0
                for k in _kind_classes(s):
                    if k not in keep:
                        continue
                    pos.setdefault(k, []).append(i)
                    i += 1
                if any(ps[-1] - ps[0] + 1 != len(ps) for ps in pos.values()):
                    return False
            return True

        ladder = [
            {"prose", "tables", "embeds"},
            {"tables", "embeds"},
            {"prose", "tables"},
            {"prose", "embeds"},
            {"tables"},
            {"embeds"},
            set(),
        ]
        keep = next((k for k in ladder if _contiguous_for(k)), set())
        pos_map = {}
        for i, k in enumerate(_kind_classes(occ[0])):
            if k not in keep:
                continue
            pos_map.setdefault(k, []).append(i)

        def _rank(key, tie):
            first = pos_map.get(key, [None])[0]
            return (float("inf") if first is None else first) * 100 + tie

        chunks = []

        lens = ([] if "prose" not in keep
                else [len(_prose_text(s)) for s in occ if s["paras"]])
        all_prose = all(s["paras"] for s in occ)
        if lens:
            pcard = "required" if all_prose else "optional"
            min_len = min(lens)
            chunks.append({"rank": _rank("prose", 0), "lines": [
                "",
                f"prose {pcard} minLength={min_len}" if min_len > 0
                else f"prose {pcard}",
                "",
                "expect:",
                f"  TODO: describe what the {g['label']} section must convey.",
                "",
                "validate:",
                "  semantic: optional",
            ]})

        by_occ = [_classify_bullets(s["bullets"]) for s in occ]
        field_labels = {}
        for fields, _plain in by_occ:
            for label, value in fields:
                field_labels.setdefault(label, []).append(value)
        first_field = True
        for label, values in field_labels.items():
            present = sum(1 for fields, _ in by_occ
                          if any(f[0] == label for f in fields))
            fcard = "" if present == n else " optional"
            # empty values mean missing data, not a type: infer from concrete
            # values and mark the declaration nullable (section 23.1)
            saw_empty = any(v == "" for v in values)
            ftype = _infer_type([v for v in values if v != ""])
            nullable = " nullable" if saw_empty else ""
            if first_field:
                out.append("")
                first_field = False
            out.append(f"- {label}: {ftype}{fcard}{nullable}")

        list_counts = [len(plain) for _fields, plain in by_occ]
        if any(c > 0 for c in list_counts):
            all_list = all(c > 0 for c in list_counts)
            lcard = "" if all_list else " optional"
            min_items = min(list_counts)
            out.append("")
            tail = f" minItems={min_items}" if all_list and min_items > 1 else ""
            out.append(f"list string{lcard}{tail}")

        # tables grouped by column signature (skipped for content-open
        # sections)
        sigs = {}
        sig_order = []
        if "tables" in keep:
            for s in occ:
                for t in s["tables"]:
                    sig = "|".join(c.strip() for c in t["columns"])
                    if sig not in sigs:
                        sigs[sig] = []
                        sig_order.append(sig)
                    sigs[sig].append(t)
        t_idx = 0
        for sig in sig_order:
            tabs = sigs[sig]
            t_idx += 1
            tcard = "" if len(tabs) == n else " optional"
            # ragged sources can yield empty header names; such columns are
            # undeclarable. Cells keep their ORIGINAL header index while
            # names are filtered.
            col_defs = [{"name": _clean_label(name.strip()), "idx": idx}
                        for idx, name in enumerate(sig.split("|"))]
            col_defs = [x for x in col_defs if x["name"] != ""]
            if not col_defs:
                continue
            col_specs = []
            for x in col_defs:
                values = []
                empty = False
                for t in tabs:
                    for row in t["rows"]:
                        c = x["idx"]
                        cell = row["cells"][c] if c < len(row["cells"]) else ""
                        if cell == "":
                            empty = True
                        else:
                            values.append(cell)
                nullable = empty or not values
                col_specs.append((_infer_type(values), nullable))
            name = _pascal([g["label"]]) + (str(t_idx) if t_idx > 1 else "")
            chunks.append({"rank": _rank("tables", t_idx), "lines": [
                "",
                f"table {name}{tcard}",
                *[
                    f"- {_safe_label(x['name'])}: "
                    f"{col_specs[i][0] if i < len(col_specs) else 'string'}"
                    f"{' nullable' if i < len(col_specs) and col_specs[i][1] else ''}"
                    for i, x in enumerate(col_defs)
                ],
            ]})

        # fenced embeds: bound POSITIONALLY — the validator pairs fence[i]
        # with the i-th embed declaration — so emit ONE declaration per
        # observed fence slot of the first occurrence, in document order.
        f0 = (occ[0].get("fences") or []) if "embeds" in keep else []
        for idx in range(len(f0)):
            lang = str(f0[idx].get("lang") or "").lower()
            if lang == "":
                continue
            same_everywhere = all(
                idx < len(s.get("fences") or [])
                and str(s["fences"][idx].get("lang") or "").lower() == lang
                for s in occ)
            chunks.append({"rank": _rank("embeds", idx + 1), "lines": [
                "",
                f"embed {lang}{'' if same_everywhere else ' optional'}",
                "",
                "expect:",
                f"  TODO: describe what the {_embed_noun(lang)} must show.",
                "",
                "validate:",
                "  semantic: optional",
            ]})

        # emit positional content in the order the document shows it
        chunks.sort(key=lambda c: c["rank"])
        for c in chunks:
            out.extend(c["lines"])

    schema_text = "\n".join(out) + "\n"
    r = validate_document(
        doc_text=doc_text, doc_name=doc_name,
        schema_text=schema_text, schema_name="draft.mds",
        base_dir=os.getcwd(),
        max_diagnostics=None, enable_optional_libs=False,
    )
    return {"schemaText": schema_text, "exitCode": r["exitCode"], "stream": r["stream"]}
