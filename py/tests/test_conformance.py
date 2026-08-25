#!/usr/bin/env python3
"""Conformance runner (Annex B).

Walks every directory under ``conformance/`` that contains a ``case.md``,
runs :func:`mds.validate.validate_document` against it and compares stdout
byte-for-byte with ``expected.txt`` (comments starting with ``#`` are
stripped). The first expected line doubles as the verdict tag: ``valid``,
``invalid`` or ``error`` (exit code 2, schema broken). Fixture flags such as
``# flags: --max 1`` are applied to the run.

Mirrors ``js/test/conformance.test.js``.
"""

from pathlib import Path

import pytest

from mds.validate import validate_document

ROOT = Path(__file__).resolve().parents[2] / "conformance"


def _collect_cases(directory, out=None):
    if out is None:
        out = []
    if (directory / "case.md").exists():
        out.append(directory)
    for entry in sorted(directory.iterdir()):
        if entry.is_dir():
            _collect_cases(entry, out)
    return out


def _parse_expected(text):
    lines = text.replace("\r\n", "\n").split("\n")
    verdict = lines[0].strip() if lines else ""
    flags = {}
    body = []
    for ln in lines[1:]:
        if ln.startswith("#"):
            import re

            fm = re.match(r"^#\s*flags:\s*(.+)$", ln)
            if fm:
                toks = fm.group(1).strip().split()
                k = 0
                while k < len(toks):
                    if toks[k] == "--max":
                        flags["max"] = int(toks[k + 1])
                    k += 1
            continue
        body.append(ln)
    while body and body[-1] == "":
        body.pop()
    return {"verdict": verdict, "flags": flags, "body": body}


CASES = _collect_cases(ROOT)


@pytest.mark.parametrize("case_dir", CASES, ids=lambda d: str(d.relative_to(ROOT)))
def test_conformance(case_dir):
    expected = _parse_expected((case_dir / "expected.txt").read_text(encoding="utf-8"))
    r = validate_document(
        doc_text=(case_dir / "case.md").read_text(encoding="utf-8"),
        doc_name="case.md",
        schema_text=(case_dir / "case.mds").read_text(encoding="utf-8"),
        schema_name="case.mds",
        base_dir=str(case_dir),
        max_diagnostics=expected["flags"].get("max"),
        enable_optional_libs=False,
    )
    got_lines = r["stream"].split("\n")
    while got_lines and got_lines[-1] == "":
        got_lines.pop()
    want_exit = {"valid": 0, "error": 2}.get(expected["verdict"], 1)
    assert r["exitCode"] == want_exit, f'exit {r["exitCode"]} != {want_exit}'
    assert "\n".join(got_lines) == "\n".join(expected["body"])
