"""Diagnostic model, code registry and the normative line-based rendering.

Implements MDS specification v0.13, section 46 and Annex B/D: every
diagnostic is one Markdown list item
(``[indent]- CODE severity path file:line:col [contract file:line] message``),
the stream ends with a blank line and a ``summary:`` paragraph.

The Python reference implementation mirrors ``js/src/diagnostics.js``
statement by statement; both MUST stay byte-identical on all conformance
fixtures (Conformance Invariant, section 60).
"""

SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"
SEVERITY_INFO = "info"

#: Normative Core diagnostic registry (Annex D) plus bundled extension codes.
#: Codes are stable; never repurpose an existing one.
CODES = {
    # MDS-C0xx -- schema contract
    "SCHEMA_SYNTAX": "MDS-C001",
    "SCHEMA_UNKNOWN_STATEMENT": "MDS-C002",
    "SCHEMA_UNKNOWN_TYPE": "MDS-C003",
    "SCHEMA_BAD_CONSTRAINT_TARGET": "MDS-C004",
    "SCHEMA_BAD_CONSTRAINT_VALUE": "MDS-C005",
    "SCHEMA_BAD_PATTERN": "MDS-C006",
    "SCHEMA_NULLABLE_TARGET": "MDS-C007",
    "SCHEMA_NULLABLE_COLLISION": "MDS-C008",
    # MDS-C1xx -- document and section structure
    "MISSING_SECTION": "MDS-C101",
    "UNEXPECTED_SECTION": "MDS-C102",
    "MISSING_TITLE": "MDS-C103",
    # MDS-C2xx -- cardinality and ordering
    "ORDER_VIOLATION": "MDS-C201",
    "NON_CONTIGUOUS": "MDS-C202",
    "TOO_FEW": "MDS-C203",
    "TOO_MANY": "MDS-C204",
    "CONTENT_ORDER": "MDS-C205",
    "MISSING_FIELD": "MDS-C206",
    "UNEXPECTED_FIELD": "MDS-C207",
    "COMPOSITION_VIOLATION": "MDS-C208",
    # MDS-C3xx -- types and constraints
    "TYPE_MISMATCH": "MDS-C301",
    "CONSTRAINT_VIOLATION": "MDS-C302",
    "ENUM_VIOLATION": "MDS-C303",
    "UNION_NO_MATCH": "MDS-C304",
    "COLLECTION_VIOLATION": "MDS-C305",
    "MALFORMED_FIELD": "MDS-C306",
    "UNDECLARED_COLUMN": "MDS-C307",
    "BAD_CELL": "MDS-C308",
    # MDS-C4xx -- references and definitions
    "UNRESOLVED_REFERENCE": "MDS-C401",
    "IMPORT_CYCLE": "MDS-C402",
    "NAME_COLLISION": "MDS-C403",
    "DUPLICATE_DEFINITION": "MDS-C404",
    # MDS-C5xx -- embeds
    "MISSING_EMBED": "MDS-C501",
    "UNEXPECTED_EMBED": "MDS-C502",
    "EMBED_FORMAT_MISMATCH": "MDS-C503",
    "EMBED_FORMAT_FAILED": "MDS-C504",
    "EMBED_CONTRACT_FAILED": "MDS-C505",
    # MDS-C6xx -- metadata
    "METADATA_MALFORMED": "MDS-C601",
    "METADATA_TYPE": "MDS-C602",
    "METADATA_UNEXPECTED": "MDS-C603",
    # cross-cutting
    "TRUNCATED": "MDS-C900",
    # bundled extension codes
    "EXT_JSON_SYNTAX": "MDS-E001",
    "EXT_UNAVAILABLE": "MDS-E410",
}


class Diagnostic:
    """One structured diagnostic finding."""

    def __init__(self, code, severity, path, file, line, column=1,
                 message="", contract_file=None, contract_line=None, depth=0):
        self.code = code
        self.severity = severity
        self.path = path or "/"
        self.file = file
        self.line = line
        self.column = 1 if column is None else column
        self.message = message
        self.contract_file = contract_file
        self.contract_line = contract_line
        self.depth = depth or 0

    def render(self):
        """Render as one Markdown list item (Annex D grammar)."""
        indent = "  " * self.depth
        s = f"{indent}- {self.code} {self.severity} {self.path} {self.file}:{self.line}:{self.column}"
        if self.contract_file is not None:
            s += f" contract {self.contract_file}:{self.contract_line}"
        return f"{s} {self.message}"

    def to_object(self):
        """Plain-dict form for programmatic consumption (returned alongside
        the rendered stream). Keys are camelCase and identical across the
        Python and JavaScript implementations."""
        return {
            "code": self.code,
            "severity": self.severity,
            "path": self.path,
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "message": self.message,
            "contractFile": self.contract_file,
            "contractLine": self.contract_line,
            "depth": self.depth,
        }


def render_stream(diags, max_diags=None):
    """Render the complete diagnostic stream for a run.

    Applies the optional truncation cap (announced with ``MDS-C900``) and
    always terminates with a blank line plus the ``summary:`` paragraph. A
    truncated run cannot certify error totals - hidden findings may include
    errors - so the summary reports ``0 errors`` and surfaces the cut as one
    extra warning. The exit code is derived from the full, untruncated list
    by the caller and is unaffected by this rendering rule.
    """
    shown = list(diags)
    truncated = False
    if max_diags is not None and max_diags >= 0 and len(shown) > max_diags:
        del shown[max_diags:]
        truncated = True
    lines = [d.render() for d in shown]
    if truncated:
        lines.append(Diagnostic(
            code=CODES["TRUNCATED"], severity=SEVERITY_WARNING, path="/",
            file="-", line=1,
            message=f"diagnostic list truncated (--max {max_diags})",
        ).render())
    errors = 0 if truncated else sum(1 for d in shown if d.severity == SEVERITY_ERROR)
    warnings = sum(1 for d in shown if d.severity == SEVERITY_WARNING) + (1 if truncated else 0)
    lines.extend(["", f"summary: {errors} errors, {warnings} warnings"])
    return "\n".join(lines)


def verdict_of(has_errors):
    """Verdict word used by the conformance fixtures and CLI plumbing."""
    return "invalid" if has_errors else "valid"
