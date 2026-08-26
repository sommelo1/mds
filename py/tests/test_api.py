"""Public API surface test: all three entry points - files, strings,
streams - must produce byte-identical verdicts and diagnostic streams for
the same document/schema pair (person conformance fixture).

Mirrors ``js/test/api.test.js``.
"""

import io
import json
from pathlib import Path

from mds import validate_document, validate_files, validate_streams

ROOT = Path(__file__).resolve().parents[2]
DOC_PATH = ROOT / "conformance" / "valid" / "person" / "case.md"
SCHEMA_PATH = ROOT / "conformance" / "valid" / "person" / "case.mds"


def _test_files_entry_point():
    return validate_files(DOC_PATH, SCHEMA_PATH)


def _test_strings_entry_point():
    return validate_document(
        doc_text=DOC_PATH.read_text(encoding="utf-8"),
        schema_text=SCHEMA_PATH.read_text(encoding="utf-8"),
        doc_name=str(DOC_PATH), schema_name=str(SCHEMA_PATH),
        base_dir=str(ROOT),
    )


def _test_stream_entry_points():
    """File objects, StringIO and BytesIO iterables all work as sources."""
    with open(DOC_PATH, encoding="utf-8") as fh:
        r_file = validate_streams(fh, open(SCHEMA_PATH, encoding="utf-8"),
                                  doc_name=str(DOC_PATH),
                                  schema_name=str(SCHEMA_PATH),
                                  base_dir=str(ROOT))
    r_stringio = validate_streams(
        io.StringIO(DOC_PATH.read_text(encoding="utf-8")),
        io.StringIO(SCHEMA_PATH.read_text(encoding="utf-8")),
        doc_name=str(DOC_PATH), schema_name=str(SCHEMA_PATH),
        base_dir=str(ROOT),
    )
    r_bytesio = validate_streams(
        io.BytesIO(DOC_PATH.read_bytes()),
        io.BytesIO(SCHEMA_PATH.read_bytes()),
        doc_name=str(DOC_PATH), schema_name=str(SCHEMA_PATH),
        base_dir=str(ROOT),
    )
    return r_file, r_stringio, r_bytesio


def test_api_surface_parity():
    files = _test_files_entry_point()
    assert files["exitCode"] == 0, files["stream"]

    strings = _test_strings_entry_point()
    assert json.dumps(strings, sort_keys=True) == json.dumps(files, sort_keys=True), \
        "string entry point must match file entry point"

    r_file, r_stringio, r_bytesio = _test_stream_entry_points()
    for name, result in (("file object", r_file),
                         ("StringIO", r_stringio),
                         ("BytesIO", r_bytesio)):
        assert json.dumps(result, sort_keys=True) == json.dumps(files, sort_keys=True), \
            f"{name} entry point must match file entry point"
