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
  // Recognition-only builtins: they identify fences but do not validate
  // syntax without optional libraries (deterministic default behavior).
  const recognize = (id) => ({
    id,
    aliases: [],
    capabilities: { syntax: false },
  });
  const out = [json, recognize('yaml'), recognize('xml'), recognize('mermaid'), recognize('latex'), recognize('sql'), recognize('markdown')];
  out.find((f) => f.id === 'markdown').aliases = ['md'];
  void enableOptionalLibs; // reserved for ajv/jsonschema/yaml integration
  return out;
}
