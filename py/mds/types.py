"""MDS native type system: type-spec parsing, scalar recognition and
constraint evaluation (sections 23/24/29).

All recognizers are deliberately hand-rolled instead of library based so
that the JavaScript and Python reference implementations behave
byte-identically - a requirement of the Conformance Invariant (section 60).

Mirrors ``js/src/types.js`` statement by statement.
"""

import math
import re

RE = {
    "integer": re.compile(r"^[+-]?\d+$"),
    "number": re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$"),
    "boolean": re.compile(r"^(true|false)$"),
    "nullish": re.compile(r"^(|null)$"),
    "date": re.compile(r"^(\d{4})-(\d{2})-(\d{2})$"),
    "time": re.compile(r"^(\d{2}):(\d{2}):(\d{2})(\.\d+)?$"),
    "datetime": re.compile(
        r"^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$"),
    "duration": re.compile(
        r"^P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(?:\.\d+)?S)?)?$"),
    "uri": re.compile(r"^[A-Za-z][A-Za-z0-9+\-.]*:\S+$"),
    "uuid": re.compile(
        r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    "binary": re.compile(r"^[A-Za-z0-9+/]*={0,2}$"),
}

SCALARS = {
    "string", "integer", "number", "boolean", "null", "date", "datetime",
    "time", "duration", "uri", "uuid", "binary", "any",
}

#: Constraint keys expecting numeric values.
NUMERIC_CONSTRAINTS = {
    "minLength", "maxLength", "min", "max", "exclusiveMin", "exclusiveMax",
    "multipleOf", "minItems", "maxItems",
}


def tokenize_type_region(s):
    """Split a bracket-aware type expression into tokens.

    ``union[string, number]`` stays one token; ``string required min=0``
    splits.
    """
    out = []
    cur = []
    depth = 0
    for ch in s:
        if ch == "[":
            depth += 1
        if ch == "]":
            depth = max(0, depth - 1)
        if ch == " " and depth == 0:
            if cur:
                out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        out.append("".join(cur))
    return out


def _split_top(s):
    """Split on commas at bracket depth 0, trimming each part."""
    out = []
    cur = []
    depth = 0
    for ch in s:
        if ch == "[":
            depth += 1
        if ch == "]":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    tail = "".join(cur).strip()
    if tail:
        out.append(tail)
    return [x for x in out if len(x) > 0]


def parse_type(expr, definitions=None):
    """Parse a type expression into a spec tree (dict with ``kind``)."""
    if definitions is None:
        definitions = {}
    e = expr.strip()
    if e in definitions:
        return {"ok": True, "spec": {"kind": "ref", "name": e, "target": definitions[e]}}
    if e in SCALARS:
        return {"ok": True, "spec": {"kind": "scalar", "name": e}}
    if e.endswith("[]"):
        inner = parse_type(e[:-2], definitions)
        if inner["ok"]:
            return {"ok": True, "spec": {"kind": "array", "of": inner["spec"]}}
        return inner
    m = re.match(r"^(map|enum|union)\[([\s\S]*)\]$", e)
    if m:
        kind = m.group(1)
        parts = _split_top(m.group(2))
        if kind == "map":
            if len(parts) != 1:
                return {"ok": False, "error": f'map needs exactly one value type: "{e}"'}
            inner = parse_type(parts[0], definitions)
            if inner["ok"]:
                return {"ok": True, "spec": {"kind": "map", "of": inner["spec"]}}
            return inner
        if kind == "enum":
            if len(parts) == 0:
                return {"ok": False, "error": f'empty enum: "{e}"'}
            return {"ok": True, "spec": {"kind": "enum", "values": parts}}
        alts = []
        for p in parts:
            inner = parse_type(p, definitions)
            if not inner["ok"]:
                return inner
            alts.append(inner["spec"])
        return {"ok": True, "spec": {"kind": "union", "of": alts}}
    return {"ok": False, "error": f'unknown type "{e}"'}


def days_in_month(y, m):
    """Days in month including the Gregorian leap rule."""
    dm = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if m == 2 and y % 4 == 0 and (y % 100 != 0 or y % 400 == 0):
        return 29
    return dm[m - 1]


def infer_primitive(raw):
    """Infer the most specific native scalar kind of a raw value.

    Used by union matching so that bare ``string`` alternatives only catch
    plain text.
    """
    if RE["nullish"].match(raw):
        return "null"
    if RE["integer"].match(raw):
        return "integer"
    if RE["number"].match(raw):
        return "number"
    if RE["boolean"].match(raw):
        return "boolean"
    if RE["date"].match(raw) and check_scalar("date", raw):
        return "date"
    if RE["time"].match(raw) and check_scalar("time", raw):
        return "time"
    if RE["datetime"].match(raw) and check_scalar("datetime", raw):
        return "datetime"
    if RE["uuid"].match(raw):
        return "uuid"
    if RE["duration"].match(raw):
        return "duration"
    return "string"


def check_type(spec, raw):
    """Check a raw string value against a parsed type spec."""
    kind = spec.get("kind")
    if kind == "ref":
        return check_type(spec["target"], raw)
    if kind == "any":
        return True
    if kind == "scalar":
        return check_scalar(spec["name"], raw)
    if kind == "enum":
        return raw in spec["values"]
    if kind in ("array", "map"):
        return check_type(spec["of"], raw)
    if kind == "union":
        # Inside a union, a bare `string` alternative matches only values
        # that are not recognizable as another native scalar type -
        # otherwise it would swallow every alternative.
        for alt in spec["of"]:
            rk = alt["target"] if alt.get("kind") == "ref" else alt
            if rk.get("kind") == "scalar" and rk.get("name") == "string":
                if infer_primitive(raw) == "string":
                    return True
            elif check_type(alt, raw):
                return True
        return False
    return False


def check_scalar(name, raw):
    if name in ("string", "any"):
        return True
    if name == "null":
        return bool(RE["nullish"].match(raw))
    if name == "integer":
        return bool(RE["integer"].match(raw))
    if name == "number":
        return bool(RE["number"].match(raw))
    if name == "boolean":
        return bool(RE["boolean"].match(raw))
    if name == "binary":
        return bool(RE["binary"].match(raw))
    if name == "uuid":
        return bool(RE["uuid"].match(raw))
    if name == "uri":
        return bool(RE["uri"].match(raw))
    if name == "time":
        m = RE["time"].match(raw)
        if not m:
            return False
        return int(m.group(1)) <= 23 and int(m.group(2)) <= 59 and int(m.group(3)) <= 60
    if name == "date":
        m = RE["date"].match(raw)
        if not m:
            return False
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return 1 <= mo <= 12 and 1 <= d <= days_in_month(y, mo)
    if name == "datetime":
        m = RE["datetime"].match(raw)
        if not m:
            return False
        mo, d = int(m.group(2)), int(m.group(3))
        return (1 <= mo <= 12 and 1 <= d <= days_in_month(int(m.group(1)), mo)
                and int(m.group(4)) <= 23 and int(m.group(5)) <= 59 and int(m.group(6)) <= 60)
    if name == "duration":
        return bool(RE["duration"].match(raw))
    return False


def describe_type(spec):
    """Human name used inside diagnostic messages for a spec."""
    kind = spec.get("kind")
    if kind == "ref":
        return describe_type(spec["target"])
    if kind == "scalar":
        return spec["name"]
    if kind == "enum":
        return f'enum[{", ".join(spec["values"])}]'
    if kind == "union":
        return f'union[{", ".join(describe_type(a) for a in spec["of"])}]'
    if kind == "array":
        return describe_type(spec["of"]) + "[]"
    if kind == "map":
        return f'map[{describe_type(spec["of"])}]'
    return "any"


def match_pattern(pattern, value):
    """Compile-and-match a pattern.

    Patterns MUST be written in the common subset of ECMAScript RegExp and
    Python ``re`` (see README limitations).
    """
    try:
        return re.search(pattern, value) is not None
    except re.error:
        return False


def validate_constraint_value(key, value):
    """Validate a ``key=value`` constraint pair at schema-parse time.

    Returns an error text or None when acceptable.
    """
    if key in ("pattern", "const", "default"):
        if value == "":
            return f'empty value for constraint "{key}"'
        return None
    if key == "unique":
        return None  # flag-style
    if key in NUMERIC_CONSTRAINTS:
        try:
            ok = value != "" and math.isfinite(float(value))
        except ValueError:
            ok = False
        return None if ok else f'constraint "{key}" needs a number, got "{value}"'
    return f'unknown constraint "{key}"'


def check_constraints(constraints, raw, ctx=None):
    """Evaluate declared constraints against a raw value.

    ``ctx`` may carry collection context: ``{"count": n}`` for
    minItems/maxItems evaluated by the caller. Returns a violation message
    or None.
    """
    if ctx is None:
        ctx = {}
    for k, v in constraints.items():
        if k in ("default", "unique"):
            continue
        if k in NUMERIC_CONSTRAINTS:
            r = _check_numeric_constraint(k, v, raw, ctx)
            if r:
                return r
            continue
        if k == "pattern":
            if not match_pattern(v, raw):
                return f'pattern="{v}" violated by "{raw}"'
            continue
        if k == "const":
            if raw != v:
                return f'value "{raw}" does not equal const "{v}"'
            continue
    return None


def _check_numeric_constraint(k, v, raw, ctx):
    try:
        lim = float(v)
    except ValueError:
        return None  # parse-time validated elsewhere
    if not math.isfinite(lim):
        return None
    if k in ("minLength", "maxLength"):
        n = len(raw)
        if k == "minLength" and n < lim:
            return f"minLength={v} violated ({n})"
        if k == "maxLength" and n > lim:
            return f"maxLength={v} violated ({n})"
        return None
    if k in ("minItems", "maxItems"):
        n = ctx.get("count") or 0
        if k == "minItems" and n < lim:
            return f"minItems={v} violated ({n})"
        if k == "maxItems" and n > lim:
            return f"maxItems={v} violated ({n})"
        return None
    if not RE["number"].match(raw):
        return None  # type error reported separately
    x = float(raw)
    if k == "min" and x < lim:
        return f'min={v} violated by "{raw}"'
    if k == "max" and x > lim:
        return f'max={v} violated by "{raw}"'
    if k == "exclusiveMin" and x <= lim:
        return f'exclusiveMin={v} violated by "{raw}"'
    if k == "exclusiveMax" and x >= lim:
        return f'exclusiveMax={v} violated by "{raw}"'
    if k == "multipleOf" and abs(x / lim - round(x / lim)) > 1e-9:
        return f'multipleOf={v} violated by "{raw}"'
    return None
