/**
 * Stub pack for machine-usable embed types in GitHub/GitLab Flavored
 * Markdown. Zero-config drop-in: `node_modules/mds-ext-stubs`.
 *
 * Binding model (unchanged from core):
 *   - `embed <id>`            binds by id/alias, recognition-only suffices
 *   - `validation: required`  needs `capabilities.syntax === true`,
 *                             otherwise MDS-E410 — that is the deliberate
 *                             gap stubs leave open.
 *
 * Upgrade path: replace a stub below with a real `syntaxCheck` and flip
 * `capabilities.syntax` to `true`. `csv` is the worked reference: a
 * deterministic, dependency-free column-count validator (~20 lines).
 *
 * Covered embed types:
 *   gh+gl : math (tex)          — mermaid lives in core already; this pack
 *   gl    : plantuml              never duplicates existing core ids
 *   gh    : geojson, topojson, csv, stl, abc (music sheets)
 *   common: toml, ini (structured config embeds)
 */

/**
 * Reference implementation — smallest useful validator.
 * Naive comma split (quoted commas unsupported; see README limitations).
 * relLine is 1-based within the fenced content, matching the core's
 * forwarding convention (`startLine + relLine`).
 * @param {string} content fenced block content
 * @returns {{relLine:number,message:string}|null}
 */
export function csvSyntaxCheck(content) {
  const rows = [];
  const rawLines = content.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].trim() !== '') rows.push({ i, line: rawLines[i] });
  }
  if (rows.length === 0) return null;
  const want = rows[0].line.split(',').length;
  for (let k = 1; k < rows.length; k++) {
    const got = rows[k].line.split(',').length;
    if (got !== want) {
      return { relLine: rows[k].i + 1, message: `expected ${want} columns, found ${got}` };
    }
  }
  return null;
}

/** Recognition-only placeholder — swap for a real syntaxCheck later. */
const stub = (sid, aliases = []) => ({
  id: sid,
  aliases,
  capabilities: { syntax: false },
});

export const id = 'md-stubs';

export const formats = [
  {
    id: 'csv',
    aliases: ['tsv'],
    findingCode: 'MDS-E202',
    capabilities: { syntax: true },
    syntaxCheck: csvSyntaxCheck,
  },
  stub('math', ['tex']),
  stub('plantuml', ['puml']),
  stub('geojson'),
  stub('topojson'),
  stub('stl'),
  stub('abc'),
  stub('toml'),
  stub('ini', ['properties']),
];

export function create() {
  return { id, formats };
}
