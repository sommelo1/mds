/**
 * Bundled format extensions.
 *
 * Built-ins implement exactly the same interface as drop-in plugins
 * (`mds-ext-*` npm packages / `mds_ext` entry points), so the plugin
 * registry treats them uniformly (sections 38–40).
 *
 * Optional third-party validators (ajv, jsonschema, yaml libs) are only
 * activated when `enableOptionalLibs` is true — the default builds stay
 * dependency-free and fully deterministic (AGENTS.md rule 5).
 *
 * @module formats
 */

/**
 * Strict, tiny JSON syntax checker shared by both reference
 * implementations line-for-line so parse positions never diverge.
 *
 * @param {string} s embedded content
 * @returns {number} 0 when valid, otherwise 1-based index of the first
 *          newline before the failing character plus 1 (i.e. the line
 *          offset inside the fenced block)
 */
export function jsonSyntaxErrorLine(s) {
  let i = 0;
  const n = s.length;
  const ws = () => {
    while (i < n) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') i++;
      else break;
    }
  };
  const fail = () => {
    let line = 1;
    for (let k = 0; k < Math.min(i, n); k++) if (s[k] === '\n') line++;
    return line;
  };
  const str = () => {
    if (s[i] !== '"') return false;
    i++;
    while (i < n) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') { i++; return true; }
      if (c === '\n') return false;
      i++;
    }
    return false;
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m || m[0] === '') return false;
    i += m[0].length;
    return true;
  };
  const lit = () => {
    for (const w of ['true', 'false', 'null']) {
      if (s.startsWith(w, i)) { i += w.length; return true; }
    }
    return false;
  };
  /** forward-declared recursive descent */
  const value = () => {
    ws();
    if (i >= n) return false;
    const c = s[i];
    if (c === '{') {
      i++; ws();
      if (s[i] === '}') { i++; return true; }
      for (;;) {
        ws();
        if (!str()) return false;
        ws();
        if (s[i] !== ':') return false;
        i++;
        if (!value()) return false;
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return true; }
        return false;
      }
    }
    if (c === '[') {
      i++; ws();
      if (s[i] === ']') { i++; return true; }
      for (;;) {
        if (!value()) return false;
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return true; }
        return false;
      }
    }
    if (c === '"') return str();
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    return lit();
  };
  if (!value()) return fail();
  ws();
  if (i !== n) return fail();
  return 0;
}

/** Build a one-finding result object for the registry interface. */
function finding(relLine, message) {
  return { relLine, message };
}

/** Non-empty, trim-end lines with their original content-relative index. */
function contentLines(content) {
  const raw = String(content).split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const rows = raw.map((text, ix) => ({ text, ix: ix + 1 })).filter((r) => r.text.trim() !== '');
  return { raw, rows };
}

/**
 * GitHub/GitLab-rendered embed formats get super-minimal deterministic
 * sanity checks (no dependencies, no full parsers, no completeness
 * claim). A check reports a finding ONLY when content violates an
 * unambiguous structural requirement of its format; anything ambiguous
 * passes silently. Each check returns at most one finding; findings
 * surface as `MDS-C504`.
 */
const light = {
  math(content) {
    const { rows } = contentLines(content);
    if (rows.length === 0) return finding(1, 'empty math block');
    const s = String(content);
    let dollars = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') i++; // escaped char (e.g. \$ or \\) is never a delimiter
      else if (c === '$') dollars++;
    }
    if (dollars % 2 !== 0) return finding(rows[0].ix, 'unbalanced math delimiters ($)');
    return null;
  },
  mermaid(content) {
    // Non-exhaustive prefix whitelist; newer diagram types may be added.
    const kinds = ['graph', 'flowchart', 'sequenceDiagram', 'classDiagram',
      'stateDiagram', 'erDiagram', 'journey', 'gantt', 'pie', 'mindmap',
      'timeline', 'quadrantChart', 'gitGraph', 'requirementDiagram', 'C4',
      'sankey-beta', 'xychart-beta', 'block-beta', 'packet-beta', 'radar-beta',
      'kanban-beta', 'architecture-beta'];
    const { rows } = contentLines(content);
    if (rows.length === 0) return finding(1, 'empty mermaid block');
    const first = rows[0].text.trim();
    if (!kinds.some((k) => first.startsWith(k))) {
      return finding(rows[0].ix, 'unknown mermaid diagram type');
    }
    return null;
  },
  plantuml(content) {
    const { rows } = contentLines(content);
    if (rows.length === 0 || !/^@startuml\b/.test(rows[0].text.trim())) {
      return finding(rows[0]?.ix ?? 1, 'missing @startuml');
    }
    if (!/^@enduml\b/.test(rows[rows.length - 1].text.trim())) {
      return finding(rows[rows.length - 1].ix, 'missing @enduml');
    }
    return null;
  },
  abc(content) {
    const { rows } = contentLines(content);
    if (rows.length === 0 || !/^X:\s*\d+/.test(rows[0].text.trim())) {
      return finding(rows[0]?.ix ?? 1, 'abc must begin with an X: index field');
    }
    return null;
  },
  csv(content) {
    const { raw } = contentLines(content);
    const rows = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].trim() !== '') rows.push({ text: raw[i], line: i + 1 });
    }
    if (rows.length === 0) return finding(1, 'empty csv block');
    // Quoting makes comma counts unreliable; stay silent instead of
    // risking false positives.
    if (rows.some((r) => r.text.includes('"'))) return null;
    const headerCols = rows[0].text.split(',').length;
    for (let k = 1; k < rows.length; k++) {
      const n = rows[k].text.split(',').length;
      if (n !== headerCols) {
        return finding(rows[k].line, `row ${rows[k].line} has ${n} fields, expected ${headerCols}`);
      }
    }
    return null;
  },
  stl(content) {
    const { rows } = contentLines(content);
    if (rows.length === 0 || !/^solid\b/i.test(rows[0].text.trim())) {
      return finding(rows[0]?.ix ?? 1, 'stl must start with "solid"');
    }
    if (!/^endsolid\b/i.test(rows[rows.length - 1].text.trim())) {
      return finding(rows[rows.length - 1].ix, 'stl must end with "endsolid"');
    }
    return null;
  },
};

const jsonTyped = (re, message) => (content) => {
  const rel = jsonSyntaxErrorLine(content);
  if (rel !== 0) return finding(rel, 'invalid JSON syntax');
  if (!re.test(String(content))) return finding(1, message);
  return null;
};

/**
 * Construct the built-in format extension descriptors.
 *
 * @param {boolean} enableOptionalLibs when true, optional validators may load
 * @returns {Array<{id:string,aliases:string[],capabilities:{syntax:boolean},
 *   syntaxCheck?:Function}>}
 */
export function builtinFormats(enableOptionalLibs = false) {
  const json = {
    id: 'json',
    aliases: ['jsonc'],
    capabilities: { syntax: true },
    /**
     * Validate strict JSON syntax.
     * @param {string} content fenced block content
     * @returns {{relLine:number,message:string}|null} finding or null
     */
    syntaxCheck(content) {
      const rel = jsonSyntaxErrorLine(content);
      return rel === 0 ? null : finding(rel, 'invalid JSON syntax');
    },
  };
  const light504 = (id, aliases, check) => ({
    id,
    aliases,
    capabilities: { syntax: true },
    findingCode: 'MDS-C504',
    syntaxCheck: check,
  });
  // Recognition-only builtins: they identify fences but do not validate
  // syntax without optional libraries (deterministic default behavior).
  const recognize = (id) => ({
    id,
    aliases: [],
    capabilities: { syntax: false },
  });
  const out = [
    json,
    light504('math', ['latex', 'tex'], light.math),
    light504('mermaid', [], light.mermaid),
    light504('plantuml', ['puml'], light.plantuml),
    light504('abc', [], light.abc),
    light504('csv', [], light.csv),
    light504('geojson', [], jsonTyped(/"type"\s*:\s*"(Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon|GeometryCollection|Feature|FeatureCollection)"/, 'not a GeoJSON object')),
    light504('topojson', [], jsonTyped(/"type"\s*:\s*"Topology"/, 'not a Topology object')),
    light504('stl', [], light.stl),
    recognize('yaml'), recognize('xml'), recognize('sql'), recognize('markdown'),
    recognize('svg'),
  ];
  out.find((f) => f.id === 'markdown').aliases = ['md'];
  void enableOptionalLibs; // reserved for ajv/jsonschema/yaml integration
  return out;
}
