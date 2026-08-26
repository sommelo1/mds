"""MDS — Markdown Document Schema: Python reference implementation.

Package ``mds-core`` (console script ``mds``), stdlib-only, Python >= 3.10.
Mirrors the JavaScript reference implementation in ``js/src`` statement by
statement; both MUST stay byte-identical on all conformance fixtures.

Lib-first: everything the CLI does is available programmatically — embed
this package for tooling/CI integration, use the ``mds`` CLI for LLM/agent
loops and shell pipelines (sections 46/49).
"""

from .diagnostics import (
    CODES,
    SEVERITY_ERROR,
    SEVERITY_INFO,
    SEVERITY_WARNING,
    Diagnostic,
    render_stream,
    verdict_of,
)
from .mddoc import flatten_sections, heading_matches, norm_label, parse_document
from .schema import effective_flags, parse_schema
from .introspect import inspect_schema, scaffold_doc
from .validate import (
    drain_text,
    load_schema,
    validate_document,
    validate_files,
    validate_streams,
)

__version__ = "0.14.0"

__all__ = [
    "CODES", "Diagnostic", "SEVERITY_ERROR", "SEVERITY_INFO", "SEVERITY_WARNING",
    "drain_text", "effective_flags", "flatten_sections", "heading_matches",
    "inspect_schema", "load_schema", "norm_label", "parse_document",
    "parse_schema", "render_stream", "scaffold_doc", "validate_document",
    "validate_files", "validate_streams", "verdict_of",
    "__version__",
]
