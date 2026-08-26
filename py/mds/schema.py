"""Parser for ``.mds`` schema contracts (Annex A surface grammar).

Produces a declarative model consumed by :mod:`mds.validate`.
Unsupported-but-reserved statements (``when``, ``oneOf``, ``allOf``,
``anyOf``, ``not``) are rejected loudly with ``MDS-C002`` instead of being
silently ignored - a weaker contract must never validate silently.

Semantic expectations (``expect:``, section 21 v0.13) are captured verbatim
and exposed on the owning region; Core never validates against them.

Mirrors ``js/src/schema.js`` statement by statement.
"""

import re

from .diagnostics import CODES, SEVERITY_ERROR, Diagnostic
from .types import (
    parse_type,
    check_type,
    describe_type,
    tokenize_type_region,
    validate_constraint_value,
)

_CARDS = {"required", "optional", "one-or-more", "zero-or-more"}
_SHORTHAND = {"?": "optional", "*": "zero-or-more", "+": "one-or-more"}

_SEC_STMT = re.compile(r"^(table|list|prose|embed|additionalSections|additionalFields)\b|^-\s+")


def _parse_card_token(tok):
    if tok in _CARDS:
        return tok
    return _SHORTHAND.get(tok)


class _P:
    def __init__(self, text, file):
        self.file = file
        self.lines = str(text).split("\n")
        self.lines = [ln[:-1] if ln.endswith("\r") else ln for ln in self.lines]
        self.diags = []
        self.model = {
            "file": file,
            "documentName": None,
            "orderMode": "any",
            "additionalSections": True,
            "additionalFields": True,
            "explicitDocFlags": {},
            "expect": None, "validateSem": None,
            "sections": [],
            "definitions": {},
            "imports": [],
            "requires": {"formats": [], "schemas": []},
        }

    def err(self, code, line, message):
        self.diags.append(Diagnostic(
            code=code, severity=SEVERITY_ERROR, path="/",
            file=self.file, line=line, column=1, message=message))

    @staticmethod
    def indent_of(s):
        m = re.match(r"^ *", s)
        return len(m.group(0)) // 2


def _strip_quotes(val):
    if val.startswith('"') and val.endswith('"'):
        return val[1:-1]
    return val


def _parse_heading_tail(tail, p, line):
    """Parse ``["pattern"|words...] [as id] [card]``."""
    d = {"label": None, "glob": False, "id": None, "card": "required"}
    rest = tail
    q = re.match(r'^"([^"]*)"\s*(.*)$', rest)
    if q:
        d["label"] = q.group(1)
        d["glob"] = "*" in q.group(1)
        rest = q.group(2)
    toks = [t for t in rest.split() if t]
    k = 0
    while k < len(toks):
        t = toks[k]
        c = _parse_card_token(t)
        if c:
            d["card"] = c
            k += 1
            continue
        if t == "as" and k + 1 < len(toks):
            k += 1
            d["id"] = toks[k]
            k += 1
            continue
        if not q:
            # unquoted headings accumulate literal words only
            d["label"] = t if d["label"] is None else f"{d['label']} {t}"
        k += 1
    if d["label"] is None or d["label"] == "":
        p.err(CODES["SCHEMA_SYNTAX"], line, "invalid schema syntax: heading needs a label")
        return None
    return d


def _parse_field_body(body, p, line):
    """Parse ``Name [as id]: <type> [flags...]``."""
    cut = -1
    in_q = False
    for k, ch in enumerate(body):
        if ch == '"':
            in_q = not in_q
        if ch == ":" and not in_q:
            cut = k
            break
    if cut == -1:
        p.err(CODES["SCHEMA_SYNTAX"], line,
              'invalid schema syntax: field declaration requires ":"')
        return None
    left = body[:cut].strip()
    right = body[cut + 1:].strip()
    f = {"label": None, "glob": False, "id": None, "card": "required",
         "nullable": False, "nullTokens": []}
    # `nullable` / `nullable(t1, t2)` may contain spaces inside the parens;
    # extract it before space-based tokenization (section 23.1).
    nm = re.search(r"(?:^|\s)nullable(?:\s*\(([^)]*)\))?(?=\s|$)", right)
    if nm:
        f["nullable"] = True
        f["nullTokens"] = ([s.strip() for s in nm.group(1).split(",") if s.strip()]
                           if nm.group(1) else [])
        right = (right[:nm.start()] + " " + right[nm.end():]).strip()
    right_tokens = tokenize_type_region(right)
    q = re.match(r'^"([^"]*)"\s*(?:as\s+(\S+))?$', left)
    if q:
        f["label"] = q.group(1)
        f["glob"] = "*" in q.group(1)
        f["id"] = q.group(2)
    else:
        ltoks = [t for t in left.split() if t]
        lw = []
        k = 0
        while k < len(ltoks):
            if ltoks[k] == "as" and k + 1 < len(ltoks):
                k += 1
                f["id"] = ltoks[k]
                k += 1
                continue
            lw.append(ltoks[k])
            k += 1
        f["label"] = " ".join(lw)
    if not right_tokens:
        p.err(CODES["SCHEMA_SYNTAX"], line, "invalid schema syntax: field requires a type")
        return None
    f["typeExpr"] = right_tokens[0]
    f["constraints"] = {}
    for t in right_tokens[1:]:
        c = _parse_card_token(t)
        if c:
            f["card"] = c
            continue
        if t == "unique":
            f["constraints"]["unique"] = ""
            continue
        eq = t.find("=")
        if eq > 0:
            key = t[:eq]
            val = _strip_quotes(t[eq + 1:])
            bad = validate_constraint_value(key, val)
            if bad:
                p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], line, bad)
                continue
            f["constraints"][key] = val
            continue
        p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], line, f'unknown flag "{t}"')
    return f


def _spec_kind(spec):
    """Resolve ref chains to the concrete spec (section 23.1 helpers)."""
    s = spec
    while s["kind"] == "ref":
        s = s["target"]
    return s


def _token_collides(spec, tok):
    """True when tok is a member of the declared value language (C008 guard)."""
    s = _spec_kind(spec)
    if s["kind"] == "union":
        return any(_token_collides(alt, tok) for alt in s["of"])
    if s["kind"] == "enum":
        return tok in s["values"]
    if s["kind"] == "scalar":
        if s["name"] in ("string", "any", "null"):
            return False
        return bool(check_type(s, tok))
    return False


_NULLABLE_TARGET_MSG = ('"nullable" applies only to typed fields, table columns, '
                        'list elements and metadata entries')


def _validate_nullable(d, p, line):
    """Validate a ``nullable`` declaration after its type resolved (C007/C008)."""
    if not d.get("nullable"):
        return
    kind = _spec_kind(d["spec"])["kind"]
    if kind not in ("scalar", "enum", "union"):
        p.err(CODES["SCHEMA_NULLABLE_TARGET"], line, _NULLABLE_TARGET_MSG)
        return
    for tok in d["nullTokens"]:
        if d["constraints"].get("const") == tok or _token_collides(d["spec"], tok):
            p.err(CODES["SCHEMA_NULLABLE_COLLISION"], line,
                  f'nullable token "{tok}" collides with type {describe_type(d["spec"])}')
            return


def _resolve_field_types(f, definitions, p, line):
    r = parse_type(f["typeExpr"], definitions)
    if not r["ok"]:
        p.err(CODES["SCHEMA_UNKNOWN_TYPE"], line, r["error"])
        return False
    f["spec"] = r["spec"]
    _validate_nullable(f, p, line)
    return True


def parse_schema(text, file):
    """Parse a schema contract.

    Returns ``{"ok": bool, "model": dict, "diags": [Diagnostic]}``.
    """
    p = _P(text, file)
    M = p.model
    head_stack = []
    member_target = None   # 'define'|'embed'|'requires'|'group'|'when'|'metadata'|None
    pending_define = None
    pending_group = None
    pending_when = None
    requires_ctx = None    # 'formats'|'schemas'|None
    last_head = None
    last_table = None
    last_embed = None
    field_stack = []       # [{f, level}]
    seen_define_lines = set()
    pend = None            # active indented-block capture: expect:/validate:

    def expect_target():
        if last_embed is not None:
            return ("embed", last_embed)
        if field_stack:
            return ("field", field_stack[-1]["f"])
        if last_table is not None and last_table["cols"]:
            return ("column", last_table["cols"][-1])
        if last_head is not None:
            return ("head", last_head)
        return ("model", M)

    def finalize_pend(p):
        """Finalize a finished capture block onto its target region."""
        if p["mode"] == "expect":
            p["target"][1]["expect"] = "\n".join(p["lines"])
            return
        # validate: -- indented `key: value` pairs (section 21, v0.13)
        for ln in p["lines"]:
            idx = ln.find(":")
            if idx == -1:
                p["errs"](f'invalid schema syntax: validate expects "key: value", got "{ln}"')
                continue
            key = ln[:idx].strip()
            val = ln[idx + 1:].strip()
            if key == "semantic":
                if val not in ("optional", "required"):
                    p["errs"](f'semantic must be optional or required, got "{val}"')
                else:
                    p["target"][1]["validateSem"] = {"semantic": val, "line": p["line"]}
            else:
                p["errs"](f'unknown validate key "{key}"')

    n_lines = len(p.lines)
    for idx in range(n_lines):
        raw = p.lines[idx]
        i = idx  # 0-based loop index; diagnostics use i+1
        if raw.strip() == "":
            continue  # blank lines never end an expect block
        lvl = p.indent_of(raw)
        t = raw.strip()

        # Finalize a pending expect:/validate: capture when the block
        # dedents; the current line then continues through normal processing.
        if pend is not None:
            if lvl > pend["indent"]:
                pend["lines"].append(t)
                continue
            finalize_pend(pend)
            pend = None

        # document-level metadata declarations: `metadata` followed by
        # `- key: type card` lines at any indent (section 15, typed entries)
        if member_target == "metadata":
            mm = re.match(r"^-\s+(.+)$", t)
            if mm:
                fld = _parse_field_body(mm.group(1), p, i + 1)
                if fld is not None and _resolve_field_types(fld, M["definitions"], p, i + 1):
                    fld["line"] = i + 1
                    fld["labelNorm"] = fld["label"] if fld["glob"] \
                        else re.sub(r"\s+", " ", fld["label"]).strip()
                    M.setdefault("metadataDecls", []).append(fld)
                continue
            member_target = None  # any other statement closes the metadata block

        # a column-0 statement ends composition/conditional member collection
        if (member_target in ("group", "when")) and lvl == 0:
            pending_group = None
            pending_when = None
            member_target = None

        # composition groups and conditional contracts: members are indented
        # field declarations (`require X` inside when)
        if member_target in ("group", "when") and lvl >= 1:
            gm = re.match(r"^-\s+(.+)$", t)
            rq = re.match(r"^require\s+(\S+)$", t) if member_target == "when" else None
            if rq is not None:
                pending_when["requireNames"].append(rq.group(1))
                continue
            if gm:
                fld = _parse_field_body(gm.group(1), p, i + 1)
                if fld is None:
                    continue
                fld["line"] = i + 1
                fld["labelNorm"] = fld["label"] if fld["glob"] \
                    else re.sub(r"\s+", " ", fld["label"]).strip()
                if not _resolve_field_types(fld, M["definitions"], p, i + 1):
                    continue
                if member_target == "group":
                    fld["groupOnly"] = True
                    pending_group["members"].append(fld)
                else:
                    pending_when["fields"].append(fld)
                continue
            # non-member line closes the block
            pending_group = None
            pending_when = None
            member_target = None

        # Semantic expectation / validation binding (v0.13 section 21):
        # free-form text (expect) or key-value pairs (validate) captured
        # verbatim from deeper-indented following lines. Core exposes them
        # but never validates against the expectation itself.
        em2 = re.match(r"^expect:\s*(.*)$", t)
        if em2 and member_target in (None, "embed"):
            pend = {"mode": "expect", "indent": lvl,
                    "lines": [em2.group(1)] if em2.group(1) else [],
                    "target": expect_target(), "line": i + 1,
                    "errs": lambda m, ln=i + 1: p.err(
                        CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], ln, m)}
            continue
        vm = re.match(r"^validate:\s*(.*)$", t)
        if vm and member_target in (None, "embed"):
            pend = {"mode": "validate", "indent": lvl,
                    "lines": [vm.group(1)] if vm.group(1) else [],
                    "target": expect_target(), "line": i + 1,
                    "errs": lambda m, ln=i + 1: p.err(
                        CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], ln, m)}
            continue

        sec_scoped = bool(last_head and member_target is None
                          and (lvl >= 1 or _SEC_STMT.match(t)))

        if lvl == 0 and not sec_scoped:
            member_target = None
            requires_ctx = None
            last_table = None
            last_embed = None
            field_stack = []
            pending_group = None
            pending_when = None

            kw = t.split()[0]

            if re.match(r"^#{1,6}\s+", t):
                level = len(re.match(r"^#+", t).group(0))
                d = _parse_heading_tail(re.sub(r"^#{1,6}\s+", "", t), p, i + 1)
                if d is None:
                    continue
                h = {
                    "kind": "section", "level": level,
                    "label": d["label"], "glob": d["glob"],
                    "labelNorm": d["label"] if d["glob"]
                    else re.sub(r"\s+", " ", d["label"]).strip(),
                    "id": d["id"], "card": d["card"], "line": i + 1, "expect": None, "validateSem": None,
                    "flagLines": {},
                    "additionalSections": None, "additionalFields": None,
                    "prose": None, "list": None, "tables": [], "embeds": [], "fields": [],
                    "contentDecls": [], "children": [],
                    "groups": [], "conditions": [],
                }
                h["flagLines"] = {"additionalSections": None, "additionalFields": None}
                while head_stack and head_stack[-1]["level"] >= level:
                    head_stack.pop()
                (head_stack[-1]["children"] if head_stack else M["sections"]).append(h)
                head_stack.append(h)
                last_head = h
                last_table = None
                last_embed = None
                field_stack = []
                continue

            if kw == "document":
                name = t[len("document"):].strip()
                M["documentName"] = name or None
                continue
            if kw == "order":
                v = t[len("order"):].strip()
                if v not in ("strict", "any"):
                    p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], i + 1,
                          f'order must be "strict" or "any", got "{v}"')
                else:
                    M["orderMode"] = v
                continue
            if kw == "define":
                name = t[len("define"):].strip()
                if not name or re.search(r"\s", name):
                    p.err(CODES["SCHEMA_SYNTAX"], i + 1,
                          "invalid schema syntax: define requires a single name")
                    continue
                if name in M["definitions"]:
                    p.err(CODES["DUPLICATE_DEFINITION"], i + 1,
                          f'duplicate definition "{name}"')
                pending_define = name
                member_target = "define"
                continue
            if kw in ("use", "$ref"):
                m = re.match(r'^(?:use|\$ref)\s+"([^"]+)"', t)
                if not m:
                    p.err(CODES["SCHEMA_SYNTAX"], i + 1,
                          'invalid schema syntax: use/$ref expects a quoted path')
                    continue
                M["imports"].append({"path": m.group(1), "line": i + 1, "kw": kw})
                continue
            if kw == "metadata":
                member_target = "metadata"
                M.setdefault("metadataDecls", [])
                continue
            if kw in ("additionalSections", "additionalFields"):
                parts = t.split()
                v = parts[1] if len(parts) > 1 else ""
                if v not in ("true", "false"):
                    p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], i + 1,
                          f"{kw} must be true or false")
                    continue
                M[kw] = (v == "true")
                M["explicitDocFlags"][kw] = i + 1
                continue
            if kw == "requires":
                member_target = "requires"
                requires_ctx = None
                continue
            if kw in ("when", "oneOf", "allOf", "anyOf", "not"):
                if last_head is None:
                    p.err(CODES["SCHEMA_UNKNOWN_STATEMENT"], i + 1,
                          f'unsupported statement "{kw}"')
                    continue
                if kw == "when":
                    mw = re.match(r"^when\s+(\S+)\s*(==|!=)\s*(.+)$", t)
                    if mw is None:
                        p.err(CODES["SCHEMA_SYNTAX"], i + 1,
                              'invalid schema syntax: when expects <Field> == <value>')
                        continue
                    cond = {"field": mw.group(1), "op": mw.group(2),
                            "value": re.sub(r'^"(.*)"$', r"\1", mw.group(3).strip()),
                            "fields": [], "requireNames": [], "line": i + 1}
                    last_head["conditions"].append(cond)
                    pending_when = cond
                    pending_group = None
                    member_target = "when"
                    continue
                g = {"kind": kw, "members": [], "line": i + 1}
                last_head["groups"].append(g)
                pending_group = g
                pending_when = None
                member_target = "group"
                continue
            p.err(CODES["SCHEMA_UNKNOWN_STATEMENT"], i + 1,
                  f'unsupported statement "{kw}"')
            continue

        # ---- indented members ----
        if member_target == "define" and pending_define is not None:
            toks = tokenize_type_region(t)
            r = parse_type(toks[0] if toks else "", M["definitions"])
            if not r["ok"]:
                p.err(CODES["SCHEMA_UNKNOWN_TYPE"], i + 1, r["error"])
                continue
            cons = {}
            bad = False
            for tk in toks[1:]:
                eq = tk.find("=")
                if eq <= 0:
                    p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], i + 1,
                          f'unknown flag "{tk}"')
                    bad = True
                    continue
                key = tk[:eq]
                val = _strip_quotes(tk[eq + 1:])
                verr = validate_constraint_value(key, val)
                if verr:
                    p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], i + 1, verr)
                    bad = True
                    continue
                cons[key] = val
            if not bad:
                r["spec"]["constraints"] = cons
                M["definitions"][pending_define] = r["spec"]
            pending_define = None
            continue

        if member_target == "requires":
            if t in ("formats:", "schemas:"):
                requires_ctx = t[:-1]
                continue
            if t.startswith("- ") and requires_ctx:
                M["requires"][requires_ctx].append(t[2:].strip())
                continue
            p.err(CODES["SCHEMA_SYNTAX"], i + 1,
                  "invalid schema syntax inside requires block")
            continue

        if sec_scoped and last_head is not None:
            m_flag = re.match(r"^(additionalSections|additionalFields)\s+(true|false)$", t)
            if m_flag:
                last_head[m_flag.group(1)] = (m_flag.group(2) == "true")
                last_head.setdefault("flagLines", {})[m_flag.group(1)] = i + 1
                continue
            m_prose = re.match(r"^prose\b\s*(.*)$", t)
            if m_prose:
                pr = {"card": "required", "constraints": {}, "line": i + 1, "expect": None, "validateSem": None}
                for tk in tokenize_type_region(m_prose.group(1)):
                    if tk == "nullable" or tk.startswith("nullable("):
                        p.err(CODES["SCHEMA_NULLABLE_TARGET"], i + 1, _NULLABLE_TARGET_MSG)
                        continue
                    c = _parse_card_token(tk)
                    if c:
                        pr["card"] = c
                        continue
                    eq = tk.find("=")
                    if eq > 0:
                        key = tk[:eq]
                        val = _strip_quotes(tk[eq + 1:])
                        verr = validate_constraint_value(key, val)
                        if verr:
                            p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], i + 1, verr)
                        else:
                            pr["constraints"][key] = val
                    else:
                        p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], i + 1,
                              f'unknown flag "{tk}"')
                last_head["prose"] = pr
                last_head["contentDecls"].append({"kind": "prose", "line": i + 1})
                continue
            m_list = re.match(r"^list\b\s*(.*)$", t)
            if m_list:
                li = {"typeExpr": "string", "card": "required", "constraints": {},
                      "line": i + 1, "expect": None, "validateSem": None,
                      "nullable": False, "nullTokens": []}
                list_rest = m_list.group(1)
                lnm = re.search(r"(?:^|\s)nullable(?:\s*\(([^)]*)\))?(?=\s|$)", list_rest)
                if lnm:
                    li["nullable"] = True
                    li["nullTokens"] = ([s.strip() for s in lnm.group(1).split(",") if s.strip()]
                                        if lnm.group(1) else [])
                    list_rest = (list_rest[:lnm.start()] + " " + list_rest[lnm.end():]).strip()
                toks = tokenize_type_region(list_rest)
                ti = 0
                if (toks and not _parse_card_token(toks[0])
                        and "=" not in toks[0] and toks[0] != "unique"):
                    li["typeExpr"] = toks[ti]
                    ti += 1
                for tk in toks[ti:]:
                    c = _parse_card_token(tk)
                    if c:
                        li["card"] = c
                        continue
                    if tk == "unique":
                        li["constraints"]["unique"] = ""
                        continue
                    eq = tk.find("=")
                    if eq > 0:
                        verr = validate_constraint_value(tk[:eq], tk[eq + 1:])
                        if verr:
                            p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], i + 1, verr)
                        else:
                            li["constraints"][tk[:eq]] = tk[eq + 1:]
                    else:
                        p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], i + 1,
                              f'unknown flag "{tk}"')
                r = parse_type(li["typeExpr"], M["definitions"])
                if not r["ok"]:
                    p.err(CODES["SCHEMA_UNKNOWN_TYPE"], i + 1, r["error"])
                else:
                    li["spec"] = r["spec"]
                    _validate_nullable(li, p, i + 1)
                last_head["list"] = li
                last_head["contentDecls"].append({"kind": "list", "line": i + 1})
                continue
            m_table = re.match(r"^table\b\s*(.*)$", t)
            if m_table:
                tb = {"name": None, "card": "required", "constraints": {},
                      "cols": [], "line": i + 1, "expect": None, "validateSem": None}
                for tk in tokenize_type_region(m_table.group(1)):
                    if tk == "nullable" or tk.startswith("nullable("):
                        p.err(CODES["SCHEMA_NULLABLE_TARGET"], i + 1, _NULLABLE_TARGET_MSG)
                        continue
                    c = _parse_card_token(tk)
                    if c:
                        tb["card"] = c
                        continue
                    eq = tk.find("=")
                    if eq > 0:
                        key = tk[:eq]
                        if key == "unique":
                            tb["constraints"]["unique"] = ""
                            continue
                        verr = validate_constraint_value(key, tk[eq + 1:])
                        if verr:
                            p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], i + 1, verr)
                        else:
                            tb["constraints"][key] = tk[eq + 1:]
                    elif tb["name"] is None:
                        tb["name"] = tk
                    else:
                        p.err(CODES["SCHEMA_SYNTAX"], i + 1,
                              f'unexpected token "{tk}" in table declaration')
                last_head["tables"].append(tb)
                last_head["contentDecls"].append({"kind": "table", "line": i + 1, "ref": tb})
                last_table = tb
                last_embed = None
                continue
            m_embed = re.match(r"^embed\s+(\S+)\s*(.*)$", t)
            if m_embed:
                emb = {"format": m_embed.group(1).lower(), "card": "required",
                       "schemaRef": None, "validation": None, "line": i + 1, "expect": None, "validateSem": None}
                for tk in tokenize_type_region(m_embed.group(2)):
                    if tk == "nullable" or tk.startswith("nullable("):
                        p.err(CODES["SCHEMA_NULLABLE_TARGET"], i + 1, _NULLABLE_TARGET_MSG)
                        continue
                    c = _parse_card_token(tk)
                    if c:
                        emb["card"] = c
                        continue
                    p.err(CODES["SCHEMA_SYNTAX"], i + 1,
                          f'unexpected token "{tk}" in embed declaration')
                last_head["embeds"].append(emb)
                last_head["contentDecls"].append({"kind": "embed", "line": i + 1, "ref": emb})
                last_embed = emb
                last_table = None
                continue

        if (last_embed is not None and lvl >= 1
                and re.match(r"^(schema|validation):\s*", t)):
            ci = t.find(":")
            key = t[:ci].strip()
            val = re.sub(r'^"|"$', "", t[ci + 1:].strip())
            if key == "schema":
                last_embed["schemaRef"] = val
            elif key == "validation":
                if val not in ("optional", "required"):
                    p.err(CODES["SCHEMA_BAD_CONSTRAINT_VALUE"], i + 1,
                          f'validation must be optional or required, got "{val}"')
                else:
                    last_embed["validation"] = val
            continue

        fm = re.match(r"^-\s+(.*)$", t)
        if fm and last_head is not None:
            fld = _parse_field_body(fm.group(1), p, i + 1)
            if fld is None:
                continue
            fld["line"] = i + 1
            fld["labelNorm"] = fld["label"] if fld["glob"] \
                else re.sub(r"\s+", " ", fld["label"]).strip()
            fld["children"] = []
            fld["expect"] = None
            fld["validateSem"] = None
            if _resolve_field_types(fld, M["definitions"], p, i + 1):
                if last_table is not None:
                    last_table["cols"].append(fld)
                else:
                    while field_stack and field_stack[-1]["level"] >= lvl:
                        field_stack.pop()
                    owner = field_stack[-1]["f"] if field_stack else last_head
                    owner["fields"].append(fld)
                    field_stack.append({"f": fld, "level": lvl})
            continue

        p.err(CODES["SCHEMA_SYNTAX"], i + 1,
              f'invalid schema syntax: unrecognized line "{t[:40]}"')

    if pend is not None:  # flush a capture block that runs until end of file
        finalize_pend(pend)
        pend = None

    return {"ok": len(p.diags) == 0, "model": M, "diags": p.diags}


def effective_flags(head, ancestors, doc_model):
    """Effective ``additional*`` setting for a heading declaration.

    Honors explicit section-level overrides (section 31); the cited source
    line is the directive's own line when present, otherwise the heading's.
    """
    add_s = doc_model["additionalSections"]
    add_f = doc_model["additionalFields"]
    src_s = doc_model["explicitDocFlags"].get("additionalSections")
    src_f = doc_model["explicitDocFlags"].get("additionalFields")
    chain = ([*ancestors, head] if head is not None else list(ancestors))
    for a in chain:
        if a.get("additionalSections") is not None:
            add_s = a["additionalSections"]
            src_s = (a.get("flagLines") or {}).get("additionalSections") or a["line"]
        if a.get("additionalFields") is not None:
            add_f = a["additionalFields"]
            src_f = (a.get("flagLines") or {}).get("additionalFields") or a["line"]
    return {"addS": add_s, "addF": add_f, "srcS": src_s, "srcF": src_f}
