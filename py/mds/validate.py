"""Validation orchestrator implementing the normative two-phase algorithm.

Phase A emits structural findings in *declaration* order (missing title,
metadata problems, absent/over-counted sections, ordering violations,
missing embeds). Phase B walks matched sections in *document* order and
checks content (prose, fields, lists, tables, embeds), delegating to format
extensions and recursing into embedded ``.mds`` contracts.

The emission order is part of the conformance contract - this module
mirrors ``js/src/validate.js`` statement by statement so both
implementations produce byte-identical diagnostic streams.
"""

import os
import re

from .diagnostics import (
    CODES,
    SEVERITY_ERROR,
    Diagnostic,
    render_stream,
)
from .mddoc import flatten_sections, heading_matches, norm_label, parse_document
from .schema import effective_flags, parse_schema
from .types import check_constraints, check_type, describe_type
from .formats import builtin_formats
from .plugins import discover_plugins


def _seg_of(d):
    return d["id"] if d.get("id") else d["labelNorm"]


def _join_seg(prefix, seg):
    if prefix == "" or prefix == "/":
        return f"/{seg}"
    return f"{prefix}/{seg}"


def _norm(p):
    return p if p == "/" else (p.rstrip("/") or "/")


# --------------------------------------------------------------------------
# Schema loading (use / $ref, cycles, namespaces)
# --------------------------------------------------------------------------

def load_schema(schema_text, schema_name, base_dir):
    """Load a root schema plus transitive imports."""
    root = parse_schema(schema_text, schema_name)
    diags = list(root["diags"])
    model = root["model"]
    loaded = {}
    defs = model["definitions"]

    def walk(sub_model, model_file, directory, stack):
        for imp in sub_model["imports"]:
            target = imp["path"].split("#")[0]
            abs_p = os.path.normpath(os.path.join(directory, target))
            if abs_p in stack:
                start = stack.index(abs_p)
                chain = [os.path.basename(p) for p in [*stack[start:], abs_p]]
                diags.append(Diagnostic(
                    code=CODES["IMPORT_CYCLE"], severity=SEVERITY_ERROR, path="/",
                    file=model_file, line=imp["line"],
                    message="import cycle detected: " + " -> ".join(chain),
                ))
                continue
            if not os.path.exists(abs_p):
                diags.append(Diagnostic(
                    code=CODES["UNRESOLVED_REFERENCE"], severity=SEVERITY_ERROR, path="/",
                    file=model_file, line=imp["line"],
                    message=f'unresolved reference "{imp["path"]}"',
                ))
                continue
            if abs_p not in loaded:
                with open(abs_p, "r", encoding="utf-8") as fh:
                    parsed = parse_schema(fh.read(), os.path.basename(abs_p))
                for d0 in parsed["diags"]:
                    diags.append(d0)
                sub = parsed["model"]
                loaded[abs_p] = sub
                walk(sub, os.path.basename(abs_p), os.path.dirname(abs_p), [*stack, abs_p])
            stem = os.path.splitext(os.path.basename(target))[0]
            for name, spec in loaded[abs_p]["definitions"].items():
                key = f"{stem}.{name}"
                if key not in defs:
                    defs[key] = spec

    walk(model, schema_name, base_dir, [_abs_root(base_dir, schema_name)])
    return {"model": model, "diags": diags}


def _abs_root(base_dir, name):
    return os.path.normpath(os.path.join(base_dir, "__root__", name))


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------

def _build_registry(builtins, plugins):
    reg = {}

    def add(f):
        if not isinstance(f, dict) or not f.get("id"):
            return
        reg[f["id"].lower()] = f
        for a in f.get("aliases") or []:
            reg[str(a).lower()] = f

    for f in builtins:
        add(f)
    for p in plugins or []:
        for f in p.get("formats") or []:
            add(f)
    return reg


def _lookup_format(reg, name):
    return reg.get(str(name).lower())


def _collect_semantic_validators(plugins):
    """Flatten plugin ``validators`` descriptors into one list (section 21)."""
    out = []
    for p in plugins or []:
        for v in p.get("validators") or []:
            if isinstance(v, dict) and callable(v.get("validateExpect")):
                out.append(v)
    return out


def _requires_semantic(model):
    """Regions whose ``validate: semantic: required`` must be satisfiable."""
    holders = [model, *decl_preorder(model["sections"])]
    return any((h.get("validateSem") or {}).get("semantic") == "required"
               and h.get("expect") is not None for h in holders)


# --------------------------------------------------------------------------
# Semantic expectation evaluation (delegated, section 21)
# --------------------------------------------------------------------------

def _run_semantic_expect(out, env, holder, region_path, region_line, text):
    """Hand a region's `expect` text to every registered semantic validator.

    Core never interprets the expectation itself; findings arrive as
    extension diagnostics (`MDS-E4xx`) citing the binding line.
    """
    exp = holder.get("expect")
    vs = holder.get("validateSem")
    if not exp or not vs:
        return
    for v in env["semanticValidators"]:
        findings = v["validateExpect"]({"path": region_path, "expect": exp,
                                        "text": "" if text is None else str(text)})
        for f in findings or []:
            msg = f if isinstance(f, str) else f.get("message")
            out.append(Diagnostic(
                code=v.get("findingCode") or "MDS-E400", severity=SEVERITY_ERROR,
                path=region_path, file=env["fileName"], line=region_line, column=1,
                message=msg, contract_file=env["schemaFile"],
                contract_line=vs["line"], depth=env["depthOffset"]))


# --------------------------------------------------------------------------
# Shared pass context
# --------------------------------------------------------------------------

class Ctx:
    """Shared matching context between phase A and phase B."""

    def __init__(self, model, doc):
        self.meta = {}     # id(instance) -> {"decl": d}
        self.counts = {}   # decl line -> total matches
        self.groups = {}   # decl line -> instances[] in document order
        self._model = model

        def link(insts, parent):
            for s in insts:
                s["_parent"] = parent
                link(s["children"], s)

        link(doc["sections"], None)

        flat = []

        def rec(insts):
            for s in insts:
                flat.append(s)
                rec(s["children"])

        rec(doc["sections"])

        # Tree-aware matching (normative minimum): a declaration claims
        # instances of the same heading level anywhere in the document tree,
        # processed in declaration preorder; claimed instances are consumed
        # so that later declarations can never double-bind them.
        consumed = set()
        for d in decl_preorder(model["sections"]):
            hits = []
            for s in flat:
                if id(s) in consumed or s["level"] != d["level"]:
                    continue
                if not heading_matches(d, s["label"]):
                    continue
                consumed.add(id(s))
                self.meta[id(s)] = {"decl": d}
                hits.append(s)
            self.counts[d["line"]] = len(hits)
            if hits:
                self.groups[d["line"]] = hits

        # Semantic paths follow the *document* tree: unmatched ancestors
        # contribute nothing; repeated occurrences of one declaration under
        # the same document parent carry a positional `[n]` suffix.
        memo = {}

        def path_of(inst):
            key = id(inst)
            if key in memo:
                return memo[key]
            p = ""
            m = self.meta.get(key)
            if m:
                siblings = inst["_parent"]["children"] if inst["_parent"] else doc["sections"]
                same = [x for x in siblings
                        if self.meta.get(id(x), {}).get("decl") is m["decl"]]
                seg = _seg_of(m["decl"])
                if len(same) > 1:
                    seg += f"[{same.index(inst) + 1}]"
                pp = path_of(inst["_parent"]) if inst["_parent"] else ""
                p = _join_seg("" if pp == "/" else pp, seg)
            memo[key] = p
            return p

        for s in flat:
            if id(s) in self.meta:
                s["_path"] = path_of(s)

    def eff_for(self, sec):
        m = self.meta[id(sec)]
        anc = []
        pnt = sec["_parent"]
        while pnt:
            pm = self.meta.get(id(pnt))
            if pm:
                anc.insert(0, pm["decl"])
            pnt = pnt["_parent"]
        return effective_flags(m["decl"], anc, self._model)


def _make_ctx(model, doc):
    ctx = Ctx(model, doc)

    def eff_unmatched():
        return effective_flags(None, [], model)

    ctx.eff_unmatched = eff_unmatched
    return ctx


def decl_preorder(sections, out=None):
    if out is None:
        out = []
    for d in sections:
        out.append(d)
        decl_preorder(d["children"], out)
    return out


# --------------------------------------------------------------------------
# Phase A
# --------------------------------------------------------------------------

def _diag(code, path, file, line, column, message, c_file=None, c_line=None, depth=0):
    return Diagnostic(code=code, severity=SEVERITY_ERROR, path=path, file=file,
                      line=line, column=column, message=message,
                      contract_file=c_file, contract_line=c_line, depth=depth)


def phase_a(doc, model, ctx, env, out):
    file_name = env["fileName"]
    schema_file = env["schemaFile"]

    l1 = [d for d in decl_preorder(model["sections"]) if d["level"] == 1]
    if l1 and doc["title"] is None:
        out.append(_diag(CODES["MISSING_TITLE"], "/", file_name, 1, 1,
                         "missing required document title", schema_file, l1[0]["line"]))

    for bad in doc["metadata"]["malformed"]:
        out.append(_diag(CODES["METADATA_MALFORMED"], "/metadata", file_name, bad["line"], 1,
                         f'malformed metadata entry "{bad["text"]}"'))
    if model["additionalFields"] is False:
        for e in doc["metadata"]["entries"]:
            out.append(_diag(CODES["METADATA_UNEXPECTED"], f'/metadata/{e["key"]}',
                             file_name, e["line"], 1,
                             f'unexpected metadata key "{e["key"]}" under closed contract',
                             schema_file, model["explicitDocFlags"].get("additionalFields")))

    for d in decl_preorder(model["sections"]):
        n = ctx.counts.get(d["line"], 0)
        rep = _representative_path(d, ctx)
        if n == 0 and d["card"] == "required" and d.get("id") != "title":
            out.append(_diag(CODES["MISSING_SECTION"], rep, file_name, 1, 1,
                             f'missing required section "{d["label"]}"', schema_file, d["line"]))
        elif n == 0 and d["card"] == "one-or-more":
            out.append(_diag(CODES["TOO_FEW"], rep, file_name, 1, 1,
                             f'section "{d["label"]}" requires at least one occurrence',
                             schema_file, d["line"]))
        limit = {"required": 1, "optional": 1}.get(d["card"])
        if limit is not None and n > limit:
            off = _nth_match(ctx.groups.get(d["line"]), limit)
            out.append(_diag(CODES["TOO_MANY"],
                             off["_path"] if off else rep,
                             file_name, off["line"] if off else 1, 1,
                             f'too many occurrences of "{d["label"]}"', schema_file, d["line"]))
        # Repeated occurrences must always form one contiguous sibling group;
        # `order strict` additionally governs interleaving of different sections.
        if n > 0:
            _emit_scope_order(d, ctx, env, out)
        for em in d["embeds"]:
            if em["card"] not in ("required", "one-or-more"):
                continue
            have = _count_fences(ctx.groups.get(d["line"]))
            if have < 1:
                out.append(_diag(CODES["MISSING_EMBED"], f"{rep}/embed", file_name, 1, 1,
                                 f'missing required embed "{em["format"]}"',
                                 schema_file, em["line"]))


def _representative_path(d, ctx):
    for s in ctx.groups.get(d["line"]) or []:
        if s.get("_path"):
            return s["_path"]
    return f'/{_seg_of(d)}'


def _nth_match(hits, n):
    flat = sorted(hits or [], key=lambda s: s["line"])
    return flat[n] if n < len(flat) else None


def _count_fences(scope_arr):
    return sum(len(s["fences"]) for s in scope_arr or [])


def _emit_scope_order(d, ctx, env, out):
    """Emit C202 for one declaration grouped by document parent scope."""
    hits = ctx.groups.get(d["line"]) or []
    if len(hits) < 2:
        return
    by_parent = {}
    for h in hits:
        key = h["_parent"]["line"] if h["_parent"] else 0
        by_parent.setdefault(key, []).append(h)
    for hs in by_parent.values():
        if len(hs) < 2:
            continue
        first, last = hs[0]["line"], hs[-1]["line"]
        sibs = hs[0]["_parent"]["children"] if hs[0]["_parent"] else env["doc"]["sections"]
        between = [s for s in sibs
                   if first < s["line"] < last and _meta_decl_line(ctx, s) != d["line"]]
        if between:
            offender = hs[1]
            out.append(_diag(CODES["NON_CONTIGUOUS"], offender["_path"], env["fileName"],
                             offender["line"], 1,
                             f'repeated sections "{d["label"]}" are not contiguous',
                             env["schemaFile"], d["line"]))


def _meta_decl_line(ctx, sec):
    m = ctx.meta.get(id(sec))
    return m["decl"]["line"] if m else None


def emit_document_order_violations(doc, model, ctx, env, out):
    """Strict sibling-order check over the whole document tree (C201)."""
    if model["orderMode"] != "strict":
        return
    order_ix = {d["line"]: ix for ix, d in enumerate(decl_preorder(model["sections"]))}

    def visit(insts):
        last_ix = -1
        reported = set()
        for s in insts:
            m = ctx.meta.get(id(s))
            if m:
                ix = order_ix.get(m["decl"]["line"])
                if ix is not None:
                    if ix < last_ix and m["decl"]["line"] not in reported:
                        reported.add(m["decl"]["line"])
                        out.append(_diag(CODES["ORDER_VIOLATION"], s["_path"], env["fileName"],
                                         s["line"], 1,
                                         f'section "{m["decl"]["label"]}" out of declared order',
                                         env["schemaFile"], m["decl"]["line"]))
                    else:
                        last_ix = max(last_ix, ix)
            visit(s["children"])

    visit(doc["sections"])


# --------------------------------------------------------------------------
# Phase B helpers
# --------------------------------------------------------------------------

def _resolve_kind(spec):
    s = spec
    while s.get("kind") == "ref":
        s = s["target"]
    return s


def _type_fail(spec, raw):
    rk = _resolve_kind(spec)
    described = describe_type(spec)
    if rk["kind"] == "enum":
        return CODES["ENUM_VIOLATION"], f'value "{raw}" is not one of {described}'
    if rk["kind"] == "union":
        return CODES["UNION_NO_MATCH"], f'value "{raw}" matches none of {described}'
    return CODES["TYPE_MISMATCH"], f'value "{raw}" does not match type {described}'


def _push(out, code, path, file, line, message, contract=None, depth=0):
    out.append(_diag(code, path, file, line, 1, message,
                     contract.get("cFile") if contract else None,
                     contract.get("cLine") if contract else None, depth))


def check_field(f, value_part, bullet, f_path, eff, env, out):
    """Validate one field bullet (recursing into declared object children)."""
    file_name = env["fileName"]
    schema_file = env["schemaFile"]
    contract = {"cFile": schema_file, "cLine": f["line"]}
    if f.get("children"):
        if value_part != "":
            _push(out, CODES["MALFORMED_FIELD"], f_path, file_name, bullet["line"],
                  f'malformed field entry "{f["label"]}"', contract)
        seen = set()
        for cb in bullet.get("children") or []:
            ci = cb["text"].find(":")
            clabel = cb["text"] if ci == -1 else cb["text"][:ci]
            clabel = clabel.strip()
            cval = "" if ci == -1 else cb["text"][ci + 1:].strip()
            cand = next((cf for cf in f["children"]
                         if cf["labelNorm"] == norm_label(clabel) or cf.get("id") == clabel), None)
            if cand is None:
                if eff["addF"] is False:
                    _push(out, CODES["UNEXPECTED_FIELD"], f"{f_path}/{clabel}", file_name,
                          cb["line"], f'unexpected field "{clabel}" under closed contract',
                          {"cFile": schema_file, "cLine": eff.get("srcF")})
                continue
            seen.add(id(cand))
            check_field(cand, cval, cb, f"{f_path}/{cand.get('id') or cand['labelNorm']}",
                        eff, env, out)
        for cf in f["children"]:
            if cf["card"] == "required" and id(cf) not in seen:
                _push(out, CODES["MISSING_FIELD"],
                      f"{f_path}/{cf.get('id') or cf['labelNorm']}", file_name, 1,
                      f'missing required field "{cf["label"]}"',
                      {"cFile": schema_file, "cLine": cf["line"]})
        return
    if _resolve_kind(f["spec"])["kind"] == "array":
        elems = [] if value_part == "" else re_split_commas(value_part)
        for ix, el in enumerate(elems):
            if not check_type(f["spec"], el):
                _push(out, CODES["TYPE_MISMATCH"], f"{f_path}[{ix + 1}]", file_name,
                      bullet["line"],
                      f'value "{el}" does not match type '
                      f'{describe_type(_resolve_kind(f["spec"])["of"])}', contract)
        cc = check_constraints(f["constraints"], value_part, {"count": len(elems)})
        if cc:
            _push(out, CODES["COLLECTION_VIOLATION"], f_path, file_name, bullet["line"],
                  cc, contract)
        if "unique" in f["constraints"]:
            seen_idx = {}
            for ix, el in enumerate(elems):
                if el in seen_idx:
                    _push(out, CODES["COLLECTION_VIOLATION"], f_path, file_name,
                          bullet["line"],
                          f'unique violated at rows {seen_idx[el] + 1} and {ix + 1}', contract)
                    break
                seen_idx[el] = ix
        return
    if not check_type(f["spec"], value_part):
        code, msg = _type_fail(f["spec"], value_part)
        _push(out, code, f_path, file_name, bullet["line"], msg, contract)
        return
    cc = check_constraints(f["constraints"], value_part, {})
    if cc:
        _push(out, CODES["CONSTRAINT_VIOLATION"], f_path, file_name, bullet["line"],
              cc, contract)


def re_split_commas(value):
    """JS `value.split(/\\\\s*,\\\\s*/)` semantics."""
    return re.split(r"\s*,\s*", value)


# --------------------------------------------------------------------------
# Phase B - one matched section
# --------------------------------------------------------------------------

def phase_b_section(sec, decl, sec_path, eff, env, out):
    file_name = env["fileName"]
    schema_file = env["schemaFile"]

    if decl.get("prose"):
        text = "\n\n".join(p["text"] for p in sec["paras"])
        if text.strip() == "":
            if decl["prose"]["card"] in ("required", "one-or-more"):
                _push(out, CODES["TOO_FEW"], f"{sec_path}/prose", file_name, sec["line"],
                      "missing required prose",
                      {"cFile": schema_file, "cLine": decl["prose"]["line"]})
        else:
            cc = check_constraints(decl["prose"]["constraints"], text, {})
            if cc:
                _push(out, CODES["CONSTRAINT_VIOLATION"], f"{sec_path}/prose", file_name,
                      sec["paras"][0]["line"] if sec["paras"] else sec["line"], cc,
                      {"cFile": schema_file, "cLine": decl["prose"]["line"]})

    # positional content ordering (C205)
    observed = []
    for b in sec["blocks"]:
        if b["kind"] == "para" and decl.get("prose"):
            observed.append({"kind": "prose", "line": b["line"]})
        elif b["kind"] == "table":
            observed.append({"kind": "table", "line": b["line"]})
        elif b["kind"] == "fence":
            observed.append({"kind": "embed", "line": b["line"]})
    last_rank = -1
    offender = None
    for o in observed:
        ranks = [ix for ix, cd in enumerate(decl["contentDecls"]) if cd["kind"] == o["kind"]]
        if not ranks:
            continue
        r = ranks[0]
        if r < last_rank:
            offender = o
            break
        last_rank = r
    if offender:
        _push(out, CODES["CONTENT_ORDER"], sec_path, file_name, offender["line"],
              f'content out of declared order in "{decl["label"]}"',
              {"cFile": schema_file, "cLine": decl["line"]})

    # bullets
    seen_top = set()
    list_elems = []
    for b in sec["bullets"]:
        ci = b["text"].find(":")
        label_part = None if ci == -1 else b["text"][:ci].strip()
        value_part = "" if ci == -1 else b["text"][ci + 1:].strip()
        cand = None
        if label_part:
            cand = next((f for f in decl["fields"]
                         if f["labelNorm"] == norm_label(label_part)
                         or f.get("id") == label_part), None)
        if cand is not None:
            seen_top.add(id(cand))
            check_field(cand, value_part, b,
                        f"{sec_path}/{cand.get('id') or cand['labelNorm']}", eff, env, out)
            continue
        if label_part and eff["addF"] is False:
            _push(out, CODES["UNEXPECTED_FIELD"], f"{sec_path}/{norm_label(label_part)}",
                  file_name, b["line"], f'unexpected field "{label_part}" under closed contract',
                  {"cFile": schema_file, "cLine": eff.get("srcF")})
            continue
        if decl.get("list"):
            list_elems.append(b)
    for f in decl["fields"]:
        if f["card"] == "required" and id(f) not in seen_top:
            _push(out, CODES["MISSING_FIELD"], f"{sec_path}/{f.get('id') or f['labelNorm']}",
                  file_name, 1, f'missing required field "{f["label"]}"',
                  {"cFile": schema_file, "cLine": f["line"]})
    if decl.get("list"):
        li = decl["list"]
        for ix, b in enumerate(list_elems):
            if li.get("spec") and not check_type(li["spec"], b["text"]):
                code, msg = _type_fail(li["spec"], b["text"])
                _push(out, code, f"{sec_path}/list[{ix + 1}]", file_name, b["line"], msg,
                      {"cFile": schema_file, "cLine": li["line"]})
        cc = check_constraints(li["constraints"], "", {"count": len(list_elems)})
        if cc:
            _push(out, CODES["COLLECTION_VIOLATION"], f"{sec_path}/list", file_name,
                  li["line"], cc, {"cFile": schema_file, "cLine": li["line"]})
        if "unique" in li["constraints"]:
            seen_idx = {}
            for ix, b in enumerate(list_elems):
                txt = b["text"]
                if txt in seen_idx:
                    _push(out, CODES["COLLECTION_VIOLATION"], f"{sec_path}/list", file_name,
                          b["line"],
                          f'unique violated at rows {seen_idx[txt] + 1} and {ix + 1}',
                          {"cFile": schema_file, "cLine": li["line"]})
                    break
                seen_idx[txt] = ix

    # tables bound positionally
    for tix, tbl in enumerate(sec["tables"]):
        td = decl["tables"][tix] if tix < len(decl["tables"]) else None
        if td is None:
            if eff["addF"] is False:
                _push(out, CODES["TOO_MANY"], sec_path, file_name, tbl["headerLine"],
                      f'too many occurrences of table in "{decl["label"]}"',
                      {"cFile": schema_file, "cLine": decl["line"]})
            continue
        t_path = f"{sec_path}/{td.get('name') or 'Table[' + str(tix + 1) + ']'}"
        col_by_header = {}  # header index -> col decl
        for hx, h in enumerate(tbl["columns"]):
            cn = norm_label(h)
            cd = next((c for c in td["cols"]
                       if c["labelNorm"] == cn or c.get("id") == cn), None)
            if cd is not None:
                col_by_header[hx] = cd
            elif eff["addF"] is False:
                _push(out, CODES["UNDECLARED_COLUMN"], f"{t_path}/{cn}", file_name,
                      tbl["headerLine"], f'undeclared column "{cn}" under closed contract',
                      {"cFile": schema_file, "cLine": eff.get("srcF")})
        for cd in td["cols"]:
            if cd["card"] == "required" and cd not in col_by_header.values():
                _push(out, CODES["MISSING_FIELD"],
                      f"{t_path}/{cd.get('id') or cd['labelNorm']}", file_name,
                      tbl["headerLine"], f'missing required column "{cd["label"]}"',
                      {"cFile": schema_file, "cLine": cd["line"]})
        for ri, row in enumerate(tbl["rows"]):
            for hx, cd in col_by_header.items():
                raw = row["cells"][hx] if hx < len(row["cells"]) else ""
                if not check_type(cd["spec"], raw):
                    code, msg = _type_fail(cd["spec"], raw)
                    _push(out, code,
                          f"{t_path}[{ri + 1}]/{cd.get('id') or cd['labelNorm']}",
                          file_name, row["line"], msg,
                          {"cFile": schema_file, "cLine": cd["line"]})
                    continue
                cc = check_constraints(cd["constraints"], raw, {})
                if cc:
                    _push(out, CODES["CONSTRAINT_VIOLATION"],
                          f"{t_path}[{ri + 1}]/{cd.get('id') or cd['labelNorm']}",
                          file_name, row["line"], cc,
                          {"cFile": schema_file, "cLine": cd["line"]})
        rc = check_constraints(td["constraints"], "", {"count": len(tbl["rows"])})
        if rc:
            _push(out, CODES["COLLECTION_VIOLATION"], t_path, file_name, tbl["headerLine"],
                  rc, {"cFile": schema_file, "cLine": td["line"]})
        if "unique" in td["constraints"]:
            seen_rows = {}
            for ri, row in enumerate(tbl["rows"]):
                cells = []
                for cd in td["cols"]:
                    hx = next((h for h, c in col_by_header.items() if c is cd), None)
                    cells.append(row["cells"][hx] if hx is not None
                                 and hx < len(row["cells"]) else "")
                key = "\x1f".join(cells)
                if key in seen_rows:
                    _push(out, CODES["COLLECTION_VIOLATION"], t_path, file_name,
                          row["line"],
                          f'unique violated at rows {seen_rows[key] + 1} and {ri + 1}',
                          {"cFile": schema_file, "cLine": td["line"]})
                    break
                seen_rows[key] = ri

    # embeds bound positionally
    for fidx, fen in enumerate(sec["fences"]):
        ed = decl["embeds"][fidx] if fidx < len(decl["embeds"]) else None
        if ed is None:
            if eff["addF"] is False:
                _push(out, CODES["UNEXPECTED_EMBED"], f"{sec_path}/embed", file_name,
                      fen["startLine"], "unexpected embed under closed contract",
                      {"cFile": schema_file, "cLine": eff.get("srcF")}, env["depthOffset"] + 1)
            continue
        multi = len(decl["embeds"]) > 1
        e_path = f"{sec_path}/embed[{fidx + 1}]" if multi else f"{sec_path}/embed"
        depth = env["depthOffset"] + 1
        ext = _lookup_format(env["registry"], ed["format"])
        lang_ok = fen["lang"] != "" and (
            fen["lang"] == ed["format"]
            or (ext is not None and fen["lang"] in (ext.get("aliases") or []))
        )
        if not lang_ok:
            _push(out, CODES["EMBED_FORMAT_MISMATCH"], e_path, file_name, fen["startLine"],
                  f'embedded block declares {fen["lang"] or "?"}, contract expects '
                  f'{ed["format"]}', {"cFile": schema_file, "cLine": ed["line"]}, depth)
            continue
        if ed.get("validation") == "required" and not (
                ext and ext["capabilities"].get("syntax")):
            _push(out, CODES["EXT_UNAVAILABLE"], e_path, file_name, fen["startLine"],
                  f"required validation could not run; unavailable extension: "
                  f'{ed["format"]} (via core)', {}, depth)
            continue
        if ext and ext["capabilities"].get("syntax") and ext.get("syntaxCheck"):
            find = ext["syntaxCheck"]("\n".join(fen["content"]))
            if find:
                out.append(Diagnostic(
                    code=ext.get("findingCode") or "MDS-E001", severity=SEVERITY_ERROR,
                    path=e_path, file=file_name,
                    line=fen["startLine"] + find["relLine"], column=1,
                    message=f'{find["message"]} (via {ext["id"]})', depth=depth + 1))
        if ed.get("schemaRef"):
            handle_external_contract(ed, fen, e_path, depth, env, out)


def handle_external_contract(ed, fen, e_path, depth, env, out):
    """.mds references recurse through the core; foreign contracts require an
    optional validator extension (opt-in, rule 5) - otherwise MDS-E410."""
    ref = ed["schemaRef"]
    file_name = env["fileName"]
    if ref.lower().endswith(".mds"):
        abs_p = os.path.normpath(os.path.join(env["baseDir"], ref))
        if not os.path.exists(abs_p):
            _push(out, CODES["UNRESOLVED_REFERENCE"], e_path, file_name, fen["startLine"],
                  f'unresolved reference "{ref}"', {}, depth)
            return
        inner_name = os.path.basename(abs_p)
        with open(abs_p, "r", encoding="utf-8") as fh:
            parsed_inner = parse_schema(fh.read(), inner_name)
        inner_doc = parse_document("\n".join(fen["content"]))
        # The inner run computes depths relative to its own document;
        # forwarding below lifts every line by the outer embed depth once.
        inner_env = dict(env)
        inner_env["doc"] = inner_doc
        inner_env["schemaFile"] = inner_name
        inner_env["depthOffset"] = 0
        inner_diags = [*parsed_inner["diags"], *run_core(inner_doc, parsed_inner["model"],
                                                         inner_env)]
        for d0 in inner_diags:
            is_doc_finding = d0.file == inner_env["fileName"]
            new_path = _norm(e_path) if d0.path == "/" \
                else _norm(_join_seg(e_path, d0.path.lstrip("/")))
            out.append(Diagnostic(
                code=d0.code, severity=d0.severity, path=new_path,
                file=file_name if is_doc_finding else d0.file,
                line=(fen["startLine"] + d0.line) if is_doc_finding else d0.line,
                column=d0.column, message=d0.message,
                contract_file=d0.contract_file, contract_line=d0.contract_line,
                depth=d0.depth + depth))
        return
    if not env["jsvAvailable"]:
        _push(out, CODES["EXT_UNAVAILABLE"], e_path, file_name, fen["startLine"],
              "required validation could not run; unavailable extension: "
              "json-schema (via core)", {}, depth)
        return
    _push(out, CODES["EMBED_CONTRACT_FAILED"], e_path, file_name, fen["startLine"],
          "external contract failed without granular findings", {}, depth)


# --------------------------------------------------------------------------
# Core driver
# --------------------------------------------------------------------------

def run_core(doc, model, env):
    ctx = _make_ctx(model, doc)
    env["ctx"] = ctx
    out = []
    phase_a(doc, model, ctx, env, out)
    emit_document_order_violations(doc, model, ctx, env, out)
    has_l1_decl = any(d["level"] == 1 for d in decl_preorder(model["sections"]))
    for entry in flatten_sections(doc["sections"]):
        sec = entry["sec"]
        m = ctx.meta.get(id(sec))
        if m is None:
            eff = ctx.eff_unmatched()
            is_free_title = (sec["level"] == 1 and doc["sections"]
                             and sec is doc["sections"][0] and not has_l1_decl)
            if eff["addS"] is False and not is_free_title:
                parent_path = sec["_parent"]["_path"] if (
                    sec["_parent"] and sec["_parent"].get("_path")) else ""
                _push(out, CODES["UNEXPECTED_SECTION"],
                      _join_seg(parent_path, sec["label"]), env["fileName"], sec["line"],
                      f'unexpected section "{sec["label"]}" under closed contract',
                      {"cFile": env["schemaFile"], "cLine": eff.get("srcS")})
            continue
        phase_b_section(sec, m["decl"], sec["_path"], ctx.eff_for(sec), env, out)
        # semantic expectations bound to this section (document-level below)
        text = "\n\n".join(pp["text"] for pp in sec["paras"])
        _run_semantic_expect(out, env, m["decl"], sec["_path"], sec["line"], text)
        if m["decl"].get("prose"):
            _run_semantic_expect(out, env, m["decl"]["prose"], f'{sec["_path"]}/prose',
                                 sec["line"], text)
    # document-level expectation covers the whole document text
    doc_text = "\n\n".join(
        "\n\n".join(pp["text"] for pp in entry["sec"]["paras"])
        for entry in flatten_sections(doc["sections"]))
    doc_text = "\n\n".join(t for t in doc_text.split("\n\n") if t != "")
    _run_semantic_expect(out, env, model, "/", 1, doc_text)
    return out


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def validate_document(*, doc_text, doc_name="case.md", schema_text,
                      schema_name="case.mds", base_dir=".", max_diagnostics=None,
                      enable_optional_libs=False):
    """Validate a Markdown document against a schema contract.

    Returns ``{"exitCode": int, "stream": str, "diagnostics": list}`` where
    ``stream`` is the LLM/human-readable Markdown line output and
    ``diagnostics`` carries the same findings as structured dicts (camelCase
    keys: code, severity, path, file, line, column, message, contractFile,
    contractLine, depth) for programmatic analysis.
    """
    loaded = load_schema(schema_text, schema_name, base_dir)
    model = loaded["model"]
    load_diags = loaded["diags"]
    schema_errors = [d for d in load_diags if d.severity == SEVERITY_ERROR]
    if schema_errors:
        return {"exitCode": 2, "stream": render_stream(schema_errors, max_diagnostics),
                "diagnostics": [d.to_object() for d in schema_errors]}

    plugins = discover_plugins()
    registry = _build_registry(builtin_formats(enable_optional_libs), plugins)
    semantic_validators = _collect_semantic_validators(plugins)

    jsv_available = False
    if enable_optional_libs:
        try:
            import jsonschema  # noqa: F401
            jsv_available = True
        except ImportError:
            jsv_available = False

    pre = []

    def need_ext(cap):
        pre.append(Diagnostic(
            code=CODES["EXT_UNAVAILABLE"], severity=SEVERITY_ERROR, path="/",
            file=schema_name, line=1, column=1,
            message=f"required extension unavailable: {cap} (via core)"))

    for fid in model["requires"]["formats"]:
        if fid.lower() not in registry:
            need_ext(fid)
    for sid in model["requires"]["schemas"]:
        if not (sid == "json-schema" and jsv_available):
            need_ext(sid)
    if _requires_semantic(model) and not semantic_validators:
        need_ext("semantic")

    doc = parse_document(doc_text)
    env = {
        "doc": doc, "fileName": doc_name, "schemaFile": schema_name, "baseDir": base_dir,
        "registry": registry, "jsvAvailable": jsv_available, "depthOffset": 0,
        "semanticValidators": semantic_validators,
    }
    diags = [*pre, *run_core(doc, model, env)]
    errors = sum(1 for d in diags if d.severity == SEVERITY_ERROR)
    return {"exitCode": 1 if errors > 0 else 0,
            "stream": render_stream(diags, max_diagnostics),
            "diagnostics": [d.to_object() for d in diags]}


def validate_files(doc_path, schema_path, *, max_diagnostics=None,
                   enable_optional_libs=False):
    """Validate a document/schema pair directly from file paths.

    Convenience wrapper around :func:`validate_document`: reads both files
    and uses the paths themselves as diagnostic labels, so the names can
    never drift from the sources. ``$include`` imports resolve relative to
    the schema's directory (same as the CLI).

    Returns ``{"exitCode": int, "stream": str}``.
    """
    with open(doc_path, "r", encoding="utf-8") as fh:
        doc_text = fh.read()
    with open(schema_path, "r", encoding="utf-8") as fh:
        schema_text = fh.read()
    base_dir = os.path.dirname(os.path.abspath(str(schema_path))) or "."
    return validate_document(
        doc_text=doc_text, doc_name=str(doc_path),
        schema_text=schema_text, schema_name=str(schema_path),
        base_dir=base_dir, max_diagnostics=max_diagnostics,
        enable_optional_libs=enable_optional_libs,
    )


def _decode_chunk(chunk):
    """Decode one stream chunk (utf8 bytes or already-decoded string)."""
    if isinstance(chunk, (bytes, bytearray)):
        return bytes(chunk).decode("utf-8")
    return chunk if isinstance(chunk, str) else str(chunk)


def drain_text(source):
    """Drain any text source into one UTF-8 string.

    Plain strings pass through; file-like objects are read to EOF and plain
    iterables are joined chunk by chunk.
    """
    if isinstance(source, str):
        return source
    read = getattr(source, "read", None)
    if read is not None:
        parts = []
        while True:
            chunk = read()
            if not chunk:
                break
            parts.append(_decode_chunk(chunk))
        return "".join(parts)
    return "".join(_decode_chunk(chunk) for chunk in source)


def validate_streams(doc_stream, schema_stream, *, doc_name="case.md",
                     schema_name="case.mds", base_dir=".",
                     max_diagnostics=None, enable_optional_libs=False):
    """Validate a document/schema pair from text streams.

    Transport-layer convenience for hooks that deliver content as streams
    instead of files or fully buffered strings: file-like objects (opened
    files, ``io.StringIO``/``io.BytesIO``) and plain iterables of string or
    utf8 chunks are drained and fed through :func:`validate_document`.
    Streams carry no filename, so the optional labels name the diagnostics.

    Returns ``{"exitCode": int, "stream": str}``.
    """
    doc_text = drain_text(doc_stream)
    schema_text = drain_text(schema_stream)
    return validate_document(
        doc_text=doc_text, doc_name=doc_name,
        schema_text=schema_text, schema_name=schema_name,
        base_dir=base_dir, max_diagnostics=max_diagnostics,
        enable_optional_libs=enable_optional_libs,
    )
