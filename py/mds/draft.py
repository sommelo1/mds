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
_FENCE_LANGS = frozenset(("json",))
_FIELD_MAX_LABEL = 48
_URLISH = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
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


def _classify_bullets(items):
    """Split top-level bullets into field candidates and plain list items."""
    fields = []
    plain = []
    for b in items:
        text = b["text"]
        idx = text.find(":")
        ok_shape = 0 < idx <= _FIELD_MAX_LABEL and not _URLISH.match(text)
        label = text[:idx].strip() if ok_shape else ""
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
    """Quote a heading label whenever its bare form could parse as grammar."""
    risky = any(t.lower() in _CARDS for t in label.split())
    return f'"{label}"' if risky else label


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
        out.append("")
        out.append('# "*" as title required')

    # Declarations match instance sections anywhere in the tree, so drafting
    # from the flattened view mirrors how the validator pairs them.
    groups = {}
    order = []
    title_line = doc["title"]["line"] if doc["title"] else None
    for entry in flatten_sections(doc["sections"]):
        sec = entry["sec"]
        if sec["level"] == 1 and title_line is not None and sec["line"] == title_line:
            continue
        key = sec["label"].lower()
        if key not in groups:
            groups[key] = {"label": sec["label"], "occ": []}
            order.append(key)
        groups[key]["occ"].append(sec)

    for key in order:
        g = groups[key]
        occ = g["occ"]
        n = len(occ)
        card = "required" if n == 1 else "one-or-more"
        out.append("")
        out.append(f"## {_safe_label(g['label'])} {card}")

        lens = [len(_prose_text(s)) for s in occ if s["paras"]]
        all_prose = all(s["paras"] for s in occ)
        if lens:
            pcard = "required" if all_prose else "optional"
            min_len = min(lens)
            out.append("")
            out.append(f"prose {pcard} minLength={min_len}" if min_len > 0
                       else f"prose {pcard}")
            out.append("")
            out.append("expect:")
            out.append(f"  TODO: describe what the {g['label']} section must convey.")
            out.append("")
            out.append("validate:")
            out.append("  semantic: optional")

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

        sigs = {}
        sig_order = []
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
            cols = sig.split("|")
            width = max(len(t["columns"]) for t in tabs)
            col_specs = []
            for c in range(width):
                values = []
                empty = False
                for t in tabs:
                    for row in t["rows"]:
                        cell = row["cells"][c] if c < len(row["cells"]) else ""
                        if cell == "":
                            empty = True
                        else:
                            values.append(cell)
                nullable = empty or not values
                col_specs.append((_infer_type(values), nullable))
            name = _pascal([g["label"]]) + (str(t_idx) if t_idx > 1 else "")
            out.append("")
            out.append(f"table {name}{tcard}")
            for i, col in enumerate(cols):
                ftype, nullable = col_specs[i] if i < len(col_specs) else ("string", True)
                # empty cells mean missing data → nullable, not optional
                opt = " nullable" if nullable else ""
                out.append(f"- {col}: {ftype}{opt}")

        # fenced embeds: only JSON fences are declared; other fence languages
        # stay undeclared and remain legal under the default-open contract
        langs = {}
        lang_order = []
        for s in occ:
            for f in s["fences"]:
                if f["lang"] not in _FENCE_LANGS:
                    continue
                if f["lang"] not in langs:
                    langs[f["lang"]] = 0
                    lang_order.append(f["lang"])
                langs[f["lang"]] += 1
        for lang in lang_order:
            ecard = "" if langs[lang] == n else " optional"
            out.append("")
            out.append(f"embed {lang}{ecard}")

    schema_text = "\n".join(out) + "\n"
    r = validate_document(
        doc_text=doc_text, doc_name=doc_name,
        schema_text=schema_text, schema_name="draft.mds",
        base_dir=os.getcwd(),
        max_diagnostics=None, enable_optional_libs=False,
    )
    return {"schemaText": schema_text, "exitCode": r["exitCode"], "stream": r["stream"]}
