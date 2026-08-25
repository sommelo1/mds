"""Command-line interface for the ``mds`` command (section 58).

Thin wrapper: argv parsing, file I/O and exit codes around the library API
(:mod:`mds.validate`, :mod:`mds.introspect`). All behavior lives in the
library so it can be embedded directly (lib-first).

Commands: ``validate``, ``inspect``, ``scaffold``, ``extensions``,
``skills``, ``help``.
Diagnostics go to stdout as the normative Markdown line stream; operational
failures go to stderr. Exit codes follow section 59:
0 valid / 1 invalid / 2 schema-config failure.

Mirrors ``js/src/cli.js``.
"""

import os
import sys
from importlib import resources

from .validate import validate_document
from .introspect import inspect_schema, scaffold_doc
from .draft import draft_schema
from .formats import builtin_formats
from .plugins import discover_plugins

USAGE = """mds - Markdown Document Schema validator (spec v0.13)

Usage:
  mds validate <doc.md> <schema.mds> [--max N]
  mds inspect <schema.mds>
  mds scaffold <schema.mds>
  mds draft <doc.md>            # experimental
  mds extensions
  mds skills install [--force]
  mds help

Exit codes: 0 valid / 1 invalid / 2 schema/config failure
"""


def _fail(msg):
    sys.stderr.write(f"mds: {msg}\n")
    return 2


# Skill templates shipped with the package and their project targets.
SKILL_TARGETS = [
    ("claude-SKILL.md", ".claude/skills/mds/SKILL.md"),
    ("hermes-SKILL.md", ".hermes/skills/mds/SKILL.md"),
    ("kilo-mds.md", ".kilo/command/mds.md"),
    ("claude-SKILL-draft.md", ".claude/skills/mds-draft/SKILL.md"),
    ("hermes-SKILL-draft.md", ".hermes/skills/mds-draft/SKILL.md"),
    ("kilo-mds-draft.md", ".kilo/command/mds-draft.md"),
]


def _skills_install(force):
    """Write agent skill files into the current project (idempotent)."""
    lines = []
    written = skipped = 0
    root = resources.files("mds").joinpath("skills")
    for template, target in SKILL_TARGETS:
        text = root.joinpath(template).read_text(encoding="utf-8").replace("\r\n", "\n")
        if os.path.exists(target) and not force:
            lines.append(f"- skip {target} (exists, --force to overwrite)")
            skipped += 1
            continue
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        lines.append(f"- write {target}")
        written += 1
    lines.append(f"summary: {written} written, {skipped} skipped")
    sys.stdout.write("\n".join(lines) + "\n")
    return 0


def parse_args(argv):
    """Parse `--max N` style flags from argv."""
    positional = []
    flags = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--max":
            i += 1
            try:
                flags["max"] = int(argv[i])
            except (ValueError, IndexError):
                flags["max"] = None
        elif a == "--enable-optional-libs":
            flags["libs"] = True
        elif a == "--help":
            flags["help"] = True
        elif a == "--force":
            flags["force"] = True
        else:
            positional.append(a)
        i += 1
    return {"positional": positional, "flags": flags}


def main(argv=None):
    """CLI main entry. Returns the process exit code."""
    # Output convention (section 58): plain UTF-8 text on every platform.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    if argv is None:
        argv = sys.argv[1:]
    parsed = parse_args(list(argv))
    positional, flags = parsed["positional"], parsed["flags"]
    cmd = positional[0] if positional else None

    if not cmd or cmd == "help" or flags.get("help"):
        sys.stdout.write(USAGE)
        return 0
    try:
        if cmd == "extensions":
            all_fmts = {}
            for f in builtin_formats(flags.get("libs") or False):
                all_fmts[f["id"]] = f
            for p in discover_plugins():
                for f in p.get("formats") or []:
                    if isinstance(f, dict) and f.get("id"):
                        all_fmts[f["id"]] = f
            rows = [
                f"- {f['id']}: syntax={'yes' if f['capabilities']['syntax'] else 'recognition-only'}"
                for f in all_fmts.values()]
            sys.stdout.write("\n".join(rows) + "\n")
            return 0
        if cmd == "skills":
            if len(positional) < 2 or positional[1] != "install":
                return _fail('skills requires "install" - try "mds help"')
            return _skills_install(flags.get("force") or False)
        if cmd in ("inspect", "scaffold"):
            if len(positional) < 2:
                return _fail(f"{cmd} requires a schema path")
            with open(positional[1], "r", encoding="utf-8") as fh:
                text = fh.read()
            r = inspect_schema(text, positional[1]) if cmd == "inspect" \
                else scaffold_doc(text, positional[1])
            sys.stdout.write(r["stream"] + "\n")
            return r["exitCode"]
        if cmd == "draft":
            if len(positional) < 2:
                return _fail("draft requires a document path")
            with open(positional[1], "r", encoding="utf-8") as fh:
                doc_text = fh.read()
            r = draft_schema(doc_text, positional[1])
            sys.stdout.write(r["schemaText"])
            if r["exitCode"] != 0:
                sys.stderr.write(f"mds: draft self-check failed\n{r['stream']}\n")
                return 1
            return 0
        if cmd == "validate":
            if len(positional) < 3:
                return _fail("validate requires <doc.md> <schema.mds>")
            _, doc_path, schema_path = positional[:3]
            with open(doc_path, "r", encoding="utf-8") as fh:
                doc_text = fh.read()
            with open(schema_path, "r", encoding="utf-8") as fh:
                schema_text = fh.read()
            r = validate_document(
                doc_text=doc_text, doc_name=doc_path,
                schema_text=schema_text, schema_name=schema_path,
                base_dir=os.path.dirname(os.path.abspath(schema_path)),
                max_diagnostics=flags.get("max"),
                enable_optional_libs=flags.get("libs") or False,
            )
            sys.stdout.write(r["stream"] + "\n")
            return r["exitCode"]
        return _fail(f'unknown command "{cmd}" - try "mds help"')
    except OSError as err:
        return _fail(str(err))


def console_main():
    """Console-script entry point."""
    raise SystemExit(main())
