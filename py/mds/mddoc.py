"""Deterministic Markdown instance parser producing the MDS semantic
document model (sections 14/15 of the specification).

The parser intentionally implements a small, fully specified subset of
Markdown (ATX headings, fenced code, pipe tables, bullet lists, flat front
matter, paragraphs). Both reference implementations use the same rules
instead of a shared third-party parser so that conformance fixtures yield
identical models everywhere.

Mirrors ``js/src/mddoc.js`` statement by statement.
"""

import re


def norm_label(s):
    """Collapse whitespace runs and strip surrounding emphasis/backticks."""
    t = re.sub(r"\s+", " ", str(s).strip())
    t = re.sub(r"^[_*`]+", "", t)
    t = re.sub(r"[_*`]+$", "", t).strip()
    return re.sub(r"\s+", " ", t)


_FENCE_OPEN = re.compile(r"^(`{3,})(.*)$")
_FENCE_CLOSE = re.compile(r"^`{3,}\s*$")
_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_DELIM_ROW = re.compile(r"^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$")
_LIST_ITEM = re.compile(r"^(\s*)([-*+])\s+(.*)$")


def _split_row(line):
    t = line.strip()
    if t.startswith("|"):
        t = t[1:]
    if t.endswith("|"):
        t = t[:-1]
    return [c.strip() for c in t.split("|")]


def parse_document(text):
    """Parse a Markdown document into the semantic model.

    Returns ``{"metadata": {"entries": [...], "malformed": [...]},
    "title": {...}|None, "sections": [...]}``.
    """
    lines = str(text).split("\n")
    # normalize CRLF the way JS split(/\r?\n/) does
    lines = [ln[:-1] if ln.endswith("\r") else ln for ln in lines]
    metadata = {"entries": [], "malformed": []}
    title = None
    root_sections = []
    stack = []          # open sections
    cur = None          # current innermost section
    bullet_stack = []   # open bullets

    para_buf = []
    para_line = 0

    def flush_para():
        nonlocal para_buf, para_line
        if para_buf and cur is not None:
            cur["paras"].append({"text": "\n".join(para_buf), "line": para_line})
            cur["blocks"].append({"kind": "para", "line": para_line})
        para_buf = []
        para_line = 0

    i = 0
    n_lines = len(lines)
    # --- front matter -------------------------------------------------------
    if n_lines > 0 and lines[0].strip() == "---":
        closed = False
        i = 1
        while i < n_lines:
            if lines[i].strip() == "---":
                closed = True
                i += 1
                break
            idx = lines[i].find(":")
            if idx == -1:
                metadata["malformed"].append({"line": i + 1, "text": lines[i].strip()})
            else:
                metadata["entries"].append({
                    "key": lines[i][:idx].strip(),
                    "value": lines[i][idx + 1:].strip(),
                    "line": i + 1,
                })
            i += 1
        if not closed:  # unterminated block: treat everything as normal text
            metadata["entries"] = []
            metadata["malformed"] = []
            i = 0

    # --- body ---------------------------------------------------------------
    fence = None  # {"lang","startLine","content","ticks"}
    while i < n_lines:
        raw = lines[i]
        ln = i + 1

        if fence is not None:
            m = re.match(r"^`{3,}", raw)
            if m and _FENCE_CLOSE.match(raw) and len(m.group(0)) >= fence["ticks"]:
                if cur is not None:
                    cur["blocks"].append({"kind": "fence", "line": fence["startLine"], "ref": fence})
                fence = None
            else:
                fence["content"].append(raw)
            i += 1
            continue

        fm = _FENCE_OPEN.match(raw)
        if fm:
            flush_para()
            bullet_stack = []
            info = fm.group(2).strip()
            lang = (info.split()[0] if info.split() else "").lower()
            fence = {"lang": lang, "startLine": ln, "content": [], "ticks": len(fm.group(1))}
            if cur is not None:
                cur["fences"].append(fence)
            i += 1
            continue

        hm = _HEADING.match(raw)
        if hm:
            flush_para()
            bullet_stack = []
            level = len(hm.group(1))
            label = norm_label(hm.group(2))
            sec = {
                "level": level, "label": label, "line": ln,
                "paras": [], "bullets": [], "tables": [],
                "fences": [], "blocks": [], "children": [],
            }
            if title is None and level == 1:
                title = {"text": label, "line": ln}
            while stack and stack[-1]["level"] >= level:
                stack.pop()
            (stack[-1]["children"] if stack else root_sections).append(sec)
            stack.append(sec)
            cur = sec
            i += 1
            continue

        if re.match(r"^\s*\|", raw):
            nxt = lines[i + 1] if i + 1 < n_lines else ""
            if _DELIM_ROW.match(nxt):
                flush_para()
                bullet_stack = []
                tbl = {"headerLine": ln, "columns": _split_row(raw), "rows": []}
                i += 2  # skip header + delimiter
                while i < n_lines and re.match(r"^\s*\|", lines[i]):
                    tbl["rows"].append({"line": i + 1, "cells": _split_row(lines[i])})
                    i += 1
                if cur is not None:
                    cur["tables"].append(tbl)
                    cur["blocks"].append({"kind": "table", "line": tbl["headerLine"], "ref": tbl})
                continue

        lm = _LIST_ITEM.match(raw)
        if lm:
            flush_para()
            if cur is not None:
                indent = lm.group(1).replace("\t", "  ")
                level = len(indent) // 2
                item = {"text": lm.group(3).strip(), "line": ln, "level": level, "children": []}
                while bullet_stack and bullet_stack[-1]["level"] >= level:
                    bullet_stack.pop()
                (bullet_stack[-1]["children"] if bullet_stack else cur["bullets"]).append(item)
                bullet_stack.append(item)
            i += 1
            continue

        if raw.strip() == "":
            flush_para()
            i += 1
            continue
        if cur is None:
            i += 1
            continue  # text before the first heading is ignored
        if not para_buf:
            para_line = ln
        para_buf.append(raw.strip())
        i += 1
    if fence is not None:  # unterminated fence: still expose content deterministically
        if cur is not None:
            cur["blocks"].append({"kind": "fence", "line": fence["startLine"], "ref": fence})
    flush_para()

    return {"metadata": metadata, "title": title, "sections": root_sections}


def heading_matches(decl, instance_label):
    """Glob-aware heading match.

    Only ``*`` is special (matches any non-empty sequence); everything else
    is literal after normalization (section 17).
    """
    if not decl.get("glob"):
        return decl["labelNorm"] == instance_label
    parts = [re.escape(p) for p in decl["label"].split("*")]
    return re.fullmatch(".+".join(parts), instance_label) is not None


def flatten_sections(sections, out=None, parent=None):
    """Flatten an instance section tree in document order."""
    if out is None:
        out = []
    for s in sections:
        out.append({"sec": s, "parent": parent})
        flatten_sections(s["children"], out, s)
    return out
