/**
 * Parser for `.mds` schema contracts (Annex A surface grammar).
 *
 * Produces a declarative model consumed by {@link module:validate}.
 * Unsupported-but-reserved statements (`when`, `oneOf`, `allOf`, `anyOf`,
 * `not`) are rejected loudly with `MDS-C002` instead of being silently
 * ignored — a weaker contract must never validate silently.
 *
 * @module schema
 */
import { Diagnostic, CODES, SEVERITY } from './diagnostics.js';
import { parseType, tokenizeTypeRegion, validateConstraintValue, SCALARS } from './types.js';

const CARDS = new Set(['required', 'optional', 'one-or-more', 'zero-or-more']);
const SHORTHAND = { '?': 'optional', '*': 'zero-or-more', '+': 'one-or-more' };

class P {
  constructor(text, file) {
    this.file = file;
    this.lines = String(text).split(/\r?\n/);
    this.diags = [];
    this.model = {
      file,
      documentName: null,
      orderMode: 'any',
      additionalSections: true,
      additionalFields: true,
      explicitDocFlags: {},
      expect: null,
      validateSem: null,
      sections: [],
      definitions: new Map(),
      imports: [],
      requires: { formats: [], schemas: [] },
    };
  }

  err(code, line, message, opts = {}) {
    this.diags.push(new Diagnostic({
      code, severity: SEVERITY.ERROR, path: '/',
      file: this.file, line, column: opts.column ?? 1, message,
    }));
  }

  indentOf(s) { return Math.floor((s.match(/^ */)[0].length) / 2); }
}

function parseCardToken(tok) {
  if (CARDS.has(tok)) return tok;
  if (SHORTHAND[tok]) return SHORTHAND[tok];
  return null;
}

/**
 * Parse a heading declaration tail: `[\"pattern\"|words…] [as id] [card]`.
 */
function parseHeadingTail(tail, p, line) {
  const d = { label: null, glob: false, id: null, card: 'required' };
  let rest = tail;
  const q = rest.match(/^\"([^\"]*)\"\s*(.*)$/);
  if (q) {
    d.label = q[1];
    d.glob = q[1].includes('*');
    rest = q[2];
  }
  const toks = rest.split(/\s+/).filter(Boolean);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const c = parseCardToken(t);
    if (c) { d.card = c; continue; }
    if (t === 'as' && toks[k + 1]) { d.id = toks[++k]; continue; }
    if (!q) {
      // unquoted headings accumulate literal words only
      d.label = d.label == null ? t : `${d.label} ${t}`;
    }
  }
  if (d.label == null || d.label === '') {
    p.err(CODES.SCHEMA_SYNTAX, line, 'invalid schema syntax: heading needs a label');
    return null;
  }
  return d;
}

/**
 * Parse a field/column declaration body: `Name [as id]: <type> [flags…]`.
 */
function parseFieldBody(body, p, line) {
  const cut = (() => {
    let inQ = false;
    for (let k = 0; k < body.length; k++) {
      if (body[k] === '"') inQ = !inQ;
      if (body[k] === ':' && !inQ) return k;
    }
    return -1;
  })();
  if (cut === -1) {
    p.err(CODES.SCHEMA_SYNTAX, line, 'invalid schema syntax: field declaration requires ":"');
    return null;
  }
  const left = body.slice(0, cut).trim();
  const rightTokens = tokenizeTypeRegion(body.slice(cut + 1).trim());
  const f = { label: null, glob: false, id: null, card: 'required' };
  const q = left.match(/^\"([^\"]*)\"\s*(?:as\s+(\S+))?$/);
  if (q) {
    f.label = q[1];
    f.glob = q[1].includes('*');
    f.id = q[2] ?? null;
  } else {
    const lw = [];
    const ltoks = left.split(/\s+/).filter(Boolean);
    for (let k = 0; k < ltoks.length; k++) {
      if (ltoks[k] === 'as' && ltoks[k + 1]) { f.id = ltoks[++k]; continue; }
      lw.push(ltoks[k]);
    }
    f.label = lw.join(' ');
  }
  if (!rightTokens.length) {
    p.err(CODES.SCHEMA_SYNTAX, line, 'invalid schema syntax: field requires a type');
    return null;
  }
  f.typeExpr = rightTokens[0];
  f.constraints = new Map();
  for (let k = 1; k < rightTokens.length; k++) {
    const t = rightTokens[k];
    const c = parseCardToken(t);
    if (c) { f.card = c; continue; }
    const eq = t.indexOf('=');
    if (eq > 0) {
      const key = t.slice(0, eq);
      let val = t.slice(eq + 1);
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      const bad = validateConstraintValue(key, val);
      if (bad) { p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, line, bad); continue; }
      f.constraints.set(key, val);
      continue;
    }
    p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, line, `unknown flag "${t}"`);
  }
  return f;
}

/** Resolve a parsed field's type expression against known definitions. */
function resolveFieldTypes(f, definitions, p, line) {
  const r = parseType(f.typeExpr, definitions);
  if (!r.ok) {
    p.err(CODES.SCHEMA_UNKNOWN_TYPE, line, r.error);
    return false;
  }
  f.spec = r.spec;
  return true;
}

/**
 * Parse a schema contract.
 *
 * @param {string} text raw `.mds` source
 * @param {string} file file name used in diagnostics
 * @returns {{ok:boolean, model:object, diags:Diagnostic[]}}
 */
export function parseSchema(text, file) {
  const p = new P(text, file);
  const M = p.model;
  /** @type {Array<object>} */ let headStack = [];
  /** target collecting indented members */ let memberTarget = null; // 'define'|'embed'|'requires'|null
  let pendingDefine = null;
  let requiresCtx = null; // 'formats'|'schemas'|null
  let lastHead = null;
  let lastTable = null;
  let lastEmbed = null;
  let lastFieldOwner = null; // field accepting nested children
  /** @type {Array<{f:object,level:number}>} */ let fieldStack = [];
  let seenDefineLines = new Set();
  /** active indented-block capture: expect: or validate: */
  let pend = null;
  // Attachment priority for a bare `expect:` / `validate:` statement.
  const expectTarget = () => {
    if (lastEmbed) return lastEmbed;
    if (fieldStack.length) return fieldStack[fieldStack.length - 1].f;
    if (lastTable && lastTable.cols.length) return lastTable.cols[lastTable.cols.length - 1];
    if (lastHead) return lastHead;
    return M; // document-level expectation
  };
  /** Finalize a finished capture block onto its target region. */
  const finalizePend = (p) => {
    if (p.mode === 'expect') {
      p.target.expect = p.lines.join('\n');
      return;
    }
    // validate: — indented `key: value` pairs (section 21, v0.13)
    for (const ln of p.lines) {
      const idx = ln.indexOf(':');
      if (idx === -1) {
        p.errs(`invalid schema syntax: validate expects "key: value", got "${ln}"`);
        continue;
      }
      const key = ln.slice(0, idx).trim();
      const val = ln.slice(idx + 1).trim();
      if (key === 'semantic') {
        if (val !== 'optional' && val !== 'required') {
          p.errs(`semantic must be optional or required, got "${val}"`);
        } else {
          p.target.validateSem = { semantic: val, line: p.line };
        }
      } else {
        p.errs(`unknown validate key "${key}"`);
      }
    }
  };

  for (let i = 0; i < p.lines.length; i++) {
    const raw = p.lines[i];
    if (raw.trim() === '') continue; // blank lines never end an indented block
    const lvl = p.indentOf(raw);
    const t = raw.trim();

    // Finalize a pending expect:/validate: capture when the block dedents;
    // the current line then continues through normal statement processing.
    if (pend) {
      if (lvl > pend.indent) { pend.lines.push(t); continue; }
      finalizePend(pend);
      pend = null;
    }

    // Semantic expectation / validation binding (v0.13 section 21):
    // free-form text (expect) or key-value pairs (validate) captured
    // verbatim from deeper-indented following lines. Core exposes them but
    // never validates against the expectation itself.
    const em2 = t.match(/^expect:\s*(.*)$/);
    if (em2 && (memberTarget == null || memberTarget === 'embed')) {
      pend = { mode: 'expect', indent: lvl, lines: em2[1] ? [em2[1]] : [], target: expectTarget(), line: i + 1, errs: (m) => p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, m) };
      continue;
    }
    const vm = t.match(/^validate:\s*(.*)$/);
    if (vm && (memberTarget == null || memberTarget === 'embed')) {
      pend = { mode: 'validate', indent: lvl, lines: vm[1] ? [vm[1]] : [], target: expectTarget(), line: i + 1, errs: (m) => p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, m) };
      continue;
    }

    // Section-scoped statements may sit flush left directly after a heading
    // declaration (spec examples do) or indented below it.
    const SEC_STMT = /^(table|list|prose|embed|additionalSections|additionalFields)\b|^-\s+/;
    const secScoped = lastHead && memberTarget == null && (lvl >= 1 || SEC_STMT.test(t));

    if (lvl === 0 && !secScoped) {
      memberTarget = null; requiresCtx = null; lastTable = null; lastEmbed = null;
      fieldStack = []; lastFieldOwner = null;
      const kw = t.split(/\s+/)[0];

      if (/^#{1,6}\s+/.test(t)) {
        const level = t.match(/^#+/)[0].length;
        const d = parseHeadingTail(t.replace(/^#{1,6}\s+/, ''), p, i + 1);
        if (!d) continue;
        const h = {
          kind: 'section', level,
          label: d.label, glob: d.glob,
          labelNorm: d.glob ? d.label : d.label.replace(/\s+/g, ' ').trim(),
          id: d.id, card: d.card, line: i + 1, expect: null, validateSem: null,
          additionalSections: null, additionalFields: null,
          prose: null, list: null, tables: [], embeds: [], fields: [],
          contentDecls: [], children: [],
        };
        while (headStack.length && headStack[headStack.length - 1].level >= level) headStack.pop();
        (headStack.length ? headStack[headStack.length - 1].children : M.sections).push(h);
        headStack.push(h);
        lastHead = h; lastFieldOwner = null;
        lastTable = null; lastEmbed = null; fieldStack = [];
        continue;
      }

      switch (kw) {
        case 'document':
          M.documentName = t.slice('document'.length).trim() || null;
          continue;
        case 'order': {
          const v = t.slice('order'.length).trim();
          if (v !== 'strict' && v !== 'any') p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, `order must be "strict" or "any", got "${v}"`);
          else M.orderMode = v;
          continue;
        }
        case 'define': {
          const name = t.slice('define'.length).trim();
          if (!name || /\s/.test(name)) { p.err(CODES.SCHEMA_SYNTAX, i + 1, 'invalid schema syntax: define requires a single name'); continue; }
          if (M.definitions.has(name)) p.err(CODES.DUPLICATE_DEFINITION, i + 1, `duplicate definition "${name}"`);
          pendingDefine = name;
          memberTarget = 'define';
          continue;
        }
        case 'use':
        case '$ref': {
          const m = t.match(/^(?:use|\$ref)\s+"([^"]+)"/);
          if (!m) { p.err(CODES.SCHEMA_SYNTAX, i + 1, 'invalid schema syntax: use/$ref expects a quoted path'); continue; }
          M.imports.push({ path: m[1], line: i + 1, kw });
          continue;
        }
        case 'additionalSections':
        case 'additionalFields': {
          const v = t.split(/\s+/)[1];
          if (v !== 'true' && v !== 'false') { p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, `${kw} must be true or false`); continue; }
          M[kw] = v === 'true';
          M.explicitDocFlags[kw] = i + 1;
          continue;
        }
        case 'requires':
          memberTarget = 'requires'; requiresCtx = null;
          continue;
        case 'when': case 'oneOf': case 'allOf': case 'anyOf': case 'not':
          p.err(CODES.SCHEMA_UNKNOWN_STATEMENT, i + 1, `unsupported statement "${kw}"`);
          continue;
        default:
          p.err(CODES.SCHEMA_UNKNOWN_STATEMENT, i + 1, `unsupported statement "${kw}"`);
          continue;
      }
    }

    // ---- indented members ----
    if (memberTarget === 'define' && pendingDefine) {
      if (seenDefineLines.has(pendingDefine)) { /* only one body line */ }
      const toks = tokenizeTypeRegion(t);
      const r = parseType(toks[0] ?? '', M.definitions);
      if (!r.ok) { p.err(CODES.SCHEMA_UNKNOWN_TYPE, i + 1, r.error); continue; }
      const cons = new Map();
      let bad = false;
      for (let k = 1; k < toks.length; k++) {
        const eq = toks[k].indexOf('=');
        if (eq <= 0) { p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, `unknown flag "${toks[k]}"`); bad = true; continue; }
        const key = toks[k].slice(0, eq);
        let val = toks[k].slice(eq + 1);
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        const verr = validateConstraintValue(key, val);
        if (verr) { p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, verr); bad = true; continue; }
        cons.set(key, val);
      }
      if (!bad) {
        r.spec.constraints = cons;
        M.definitions.set(pendingDefine, r.spec);
      }
      pendingDefine = null;
      continue;
    }

    if (memberTarget === 'requires') {
      if (t.endsWith(':') && (t === 'formats:' || t === 'schemas:')) { requiresCtx = t.slice(0, -1); continue; }
      if (t.startsWith('- ') && requiresCtx) { M.requires[requiresCtx].push(t.slice(2).trim()); continue; }
      p.err(CODES.SCHEMA_SYNTAX, i + 1, 'invalid schema syntax inside requires block');
      continue;
    }

    if (secScoped && lastHead) {
      // section-scoped directives and content declarations
      const mFlag = t.match(/^(additionalSections|additionalFields)\s+(true|false)$/);
      if (mFlag) {
        lastHead[mFlag[1]] = mFlag[2] === 'true';
        lastHead.flagLines = lastHead.flagLines ?? {};
        lastHead.flagLines[mFlag[1]] = i + 1; // diagnostics cite the directive line
        continue;
      }
      const mProse = t.match(/^prose\b\s*(.*)$/);
      if (mProse) {
        const pr = { card: 'required', constraints: new Map(), line: i + 1, expect: null, validateSem: null };
        for (const tk of tokenizeTypeRegion(mProse[1])) {
          const c = parseCardToken(tk);
          if (c) { pr.card = c; continue; }
          const eq = tk.indexOf('=');
          if (eq > 0) {
            const key = tk.slice(0, eq);
            let val = tk.slice(eq + 1);
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            const verr = validateConstraintValue(key, val);
            if (verr) p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, verr);
            else pr.constraints.set(key, val);
          } else p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, `unknown flag "${tk}"`);
        }
        lastHead.prose = pr;
        lastHead.contentDecls.push({ kind: 'prose', line: i + 1 });
        continue;
      }
      const mList = t.match(/^list\b\s*(.*)$/);
      if (mList) {
        const li = { typeExpr: 'string', card: 'required', constraints: new Map(), line: i + 1, expect: null, validateSem: null };
        const toks = tokenizeTypeRegion(mList[1]);
        let ti = 0;
        if (toks.length && !parseCardToken(toks[0]) && toks[0].indexOf('=') === -1 && toks[0] !== 'unique') li.typeExpr = toks[ti++];
        for (; ti < toks.length; ti++) {
          const tk = toks[ti];
          const c = parseCardToken(tk);
          if (c) { li.card = c; continue; }
          if (tk === 'unique') { li.constraints.set('unique', ''); continue; }
          const eq = tk.indexOf('=');
          if (eq > 0) {
            const key = tk.slice(0, eq);
            const verr = validateConstraintValue(key, tk.slice(eq + 1));
            if (verr) p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, verr);
            else li.constraints.set(key, tk.slice(eq + 1));
          } else p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, `unknown flag "${tk}"`);
        }
        const r = parseType(li.typeExpr, M.definitions);
        if (!r.ok) p.err(CODES.SCHEMA_UNKNOWN_TYPE, i + 1, r.error);
        else li.spec = r.spec;
        lastHead.list = li;
        lastHead.contentDecls.push({ kind: 'list', line: i + 1 });
        continue;
      }
      const mTable = t.match(/^table\b\s*(.*)$/);
      if (mTable) {
        const tb = { name: null, card: 'required', constraints: new Map(), cols: [], line: i + 1, expect: null, validateSem: null };
        for (const tk of tokenizeTypeRegion(mTable[1])) {
          const c = parseCardToken(tk);
          if (c) { tb.card = c; continue; }
          const eq = tk.indexOf('=');
          if (eq > 0) {
            const key = tk.slice(0, eq);
            if (key === 'unique') { tb.constraints.set('unique', ''); continue; }
            const verr = validateConstraintValue(key, tk.slice(eq + 1));
            if (verr) p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, verr);
            else tb.constraints.set(key, tk.slice(eq + 1));
          } else if (!tb.name) tb.name = tk;
          else p.err(CODES.SCHEMA_SYNTAX, i + 1, `unexpected token "${tk}" in table declaration`);
        }
        lastHead.tables.push(tb);
        lastHead.contentDecls.push({ kind: 'table', line: i + 1, ref: tb });
        lastTable = tb; lastEmbed = null;
        continue;
      }
      const mEmbed = t.match(/^embed\s+(\S+)\s*(.*)$/);
      if (mEmbed) {
        const em = { format: mEmbed[1].toLowerCase(), card: 'required', schemaRef: null, validation: null, line: i + 1, expect: null, validateSem: null };
        for (const tk of tokenizeTypeRegion(mEmbed[2])) {
          const c = parseCardToken(tk);
          if (c) { em.card = c; continue; }
          p.err(CODES.SCHEMA_SYNTAX, i + 1, `unexpected token "${tk}" in embed declaration`);
        }
        lastHead.embeds.push(em);
        lastHead.contentDecls.push({ kind: 'embed', line: i + 1, ref: em });
        lastEmbed = em; lastTable = null;
        continue;
      }
    }

    if (lastEmbed && lvl >= 1 && /^(schema|validation):\s*/.test(t)) {
      const idx = t.indexOf(':');
      const key = t.slice(0, idx).trim();
      const val = t.slice(idx + 1).trim().replace(/^"|"$/g, '');
      if (key === 'schema') lastEmbed.schemaRef = val;
      else if (key === 'validation') {
        if (val !== 'optional' && val !== 'required') p.err(CODES.SCHEMA_BAD_CONSTRAINT_VALUE, i + 1, `validation must be optional or required, got "${val}"`);
        else lastEmbed.validation = val;
      }
      continue;
    }

    const fm = t.match(/^-\s+(.*)$/);
    if (fm && lastHead) {
      const fld = parseFieldBody(fm[1], p, i + 1);
      if (!fld) continue;
      fld.line = i + 1;
      fld.labelNorm = fld.glob ? fld.label : fld.label.replace(/\s+/g, ' ').trim();
      fld.children = [];
      fld.expect = null;
      fld.validateSem = null;
      if (resolveFieldTypes(fld, M.definitions, p, i + 1)) {
        if (lastTable) {
          lastTable.cols.push(fld);
        } else {
          while (fieldStack.length && fieldStack[fieldStack.length - 1].level >= lvl) fieldStack.pop();
          const owner = fieldStack.length ? fieldStack[fieldStack.length - 1].f : lastHead;
          owner.fields.push(fld);
          fieldStack.push({ f: fld, level: lvl });
        }
      }
      continue;
    }

    p.err(CODES.SCHEMA_SYNTAX, i + 1, `invalid schema syntax: unrecognized line "${t.slice(0, 40)}"`);
  }

  if (pend) { // flush a capture block that runs until end of file
    finalizePend(pend);
    pend = null;
  }

  return { ok: p.diags.length === 0, model: M, diags: p.diags };
}

/**
 * Effective `additional*` setting for a heading declaration, honoring
 * explicit section-level overrides (section 31).
 */
export function effectiveFlags(head, ancestors, docModel) {
  let addS = docModel.additionalSections;
  let addF = docModel.additionalFields;
  let srcS = docModel.explicitDocFlags.additionalSections ?? null;
  let srcF = docModel.explicitDocFlags.additionalFields ?? null;
  const chain = head ? [...ancestors, head] : ancestors;
  for (const a of chain) {
    if (a.additionalSections != null) {
      addS = a.additionalSections;
      srcS = a.flagLines?.additionalSections ?? a.line;
    }
    if (a.additionalFields != null) {
      addF = a.additionalFields;
      srcF = a.flagLines?.additionalFields ?? a.line;
    }
  }
  return { addS, addF, srcS, srcF };
}
