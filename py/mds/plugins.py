"""Zero-configuration plugin discovery (sections 37/44, AGENTS rule 4).

Python convention: any installed distribution exposing entry points in the
``mds_ext`` group contributes format extensions and/or semantic validators
using the same shape as the bundled formats. The loaded object may be a
module, class or dict carrying ``id``, ``formats`` and/or ``validators``
(optionally via a ``create()`` factory); discovery normalizes it to
``{"id", "formats", "validators"}``. Results are sorted by entry point name
so output stays deterministic regardless of installation order.

Mirrors ``js/src/plugins.js`` (the ``@mds/*`` scope convention is the JS
npm counterpart; entry points are flat here).
"""

import sys
from importlib.metadata import entry_points


def _normalize(ext, fallback_id):
    """Normalize a loaded extension object to ``{"id", "formats", "validators"}``."""
    if callable(getattr(ext, "create", None)):
        ext = ext.create()
    formats = getattr(ext, "formats", None)
    validators = getattr(ext, "validators", None)
    if not isinstance(formats, list) and not isinstance(validators, list):
        return None
    pid = getattr(ext, "id", None) or fallback_id
    return {"id": pid,
            "formats": formats if isinstance(formats, list) else [],
            "validators": validators if isinstance(validators, list) else []}


def discover_plugins(cwd=None):
    """Discover installed ``mds_ext`` extension entry points."""
    del cwd  # parity with the JS scanner; entry points are environment-wide
    try:
        eps = entry_points().select(group="mds_ext")
    except AttributeError:  # Python < 3.10 dict-style API
        eps = entry_points().get("mds_ext", [])  # noqa: SIM300
    out = []
    for ep in sorted(eps, key=lambda e: e.name):
        try:
            ext = _normalize(ep.load(), ep.name)
            if ext is not None:
                out.append(ext)
        except Exception as err:  # noqa: BLE001 - operational warning only
            sys.stderr.write(f"mds: warning: failed to load plugin {ep.name}: {err}\n")
    return out
