/**
 * Experimental schema drafting: derive a starter `.mds` contract from an
 * existing Markdown document (inverse of `scaffold`).
 *
 * The draft reuses {@link module:mddoc} so it sees the document exactly as
 * the validator does. Derived contracts are intentionally conservative and
 * deterministic: prose lengths come from the observed text, `expect:` blocks
 * are TODO stubs bound `semantic: optional`, and everything left undeclared
 * stays tolerated by the default-open contract (additionalSections /
 * additionalFields). The result is a starting point for tweaking, never a
 * finished specification.
 *
 * Pure library function — no argv handling, no process I/O. Mirrored by
 * `py/mds/draft.py`.
 *
 * @module draft
 */
import { flattenSections, parseDocument } from './mddoc.js';
import { validateDocument } from './validate.js';

const CARDS = ['required', 'optional', 'one-or-more', 'zero-or-more'];
const FENCE_LANGS = new Set(['json']);
const FIELD_MAX_LABEL = 48;
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Split document text into paragraphs the way the validator measures them. */
function proseText(sec) {
  return sec.paras.map((p) => p.text).join('\n\n');
}

/** Code-point length (mirrors the validator's minLength measurement). */
function charLen(s) {
  return [...s].length;
}

/**
 * Guess a scalar type from a sample value using the validator's detection
 * order; returns the narrowest stable type across all samples.
 */
function inferType(values) {
  const kinds = new Set();
  for (const v of values) {
    const t = v === ''
      ? 'null'
      : /^(true|false)$/.test(v) ? 'boolean'
      : /^[+-]?\d+$/.test(v) ? 'integer'
      : /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(v) ? 'number'
      : /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'date'
      : 'string';
    kinds.add(t);
  }
  kinds.delete('null');
  if (kinds.size === 0) return 'string';
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.has('string') || kinds.has('boolean') || kinds.has('date')) return 'string';
  return 'number';
}

/** Split top-level bullets into field candidates and plain list items. */
function classifyBullets(items) {
  const fields = [];
  const list = [];
  for (const b of items) {
    const idx = b.text.indexOf(':');
    const okShape = idx > 0 && idx <= FIELD_MAX_LABEL && !URLISH.test(b.text);
    const label = okShape ? b.text.slice(0, idx).trim() : '';
    if (okShape && label !== '' && !label.includes(':') && !CARDS.includes(label.toLowerCase())) {
      fields.push({ label, value: b.text.slice(idx + 1).trim() });
    } else {
      list.push(b);
    }
  }
  return { fields, list };
}

/** PascalCase identifier from a free-form label; used for document/table names. */
function pascal(parts) {
  const words = parts
    .flatMap((p) => String(p).split(/[^A-Za-z0-9]+/))
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  let name = words.join('');
  if (/^\d/.test(name)) name = `Doc${name}`;
  return name === '' ? 'Document' : name;
}

/** Quote a heading label whenever its bare form could parse as grammar. */
function safeLabel(label) {
  const risky = CARDS.some((c) => label.split(/\s+/).some((t) => t.toLowerCase() === c));
  return risky ? `"${label}"` : label;
}

function tableSignature(t) {
  return t.columns.map((c) => c.trim()).join('|');
}

/**
 * Derive a draft `.mds` contract from a Markdown document and self-check it.
 *
 * @param {object} opts
 * @param {string} opts.docText raw document source
 * @param {string} [opts.docName='doc.md'] file name (drives `document Name`)
 * @returns {Promise<{schemaText:string, exitCode:number, stream:string}>}
 *   `stream` carries the internal self-check diagnostics (empty when valid)
 */
export async function draftSchema({ docText, docName = 'doc.md' }) {
  const doc = parseDocument(docText);
  const base = String(docName).replace(/\.[^.]*$/, '');
  const out = [];

  out.push(`document ${pascal([base])}`);
  if (doc.title) {
    out.push('');
    out.push('# "*" as title required');
  }

  // --- group sections (flattened, minus the title) by normalized label ------
  // Declarations match instance sections anywhere in the tree, so drafting
  // from the flattened view mirrors how the validator pairs them.
  const groups = new Map();
  const flat = flattenSections(doc.sections);
  for (const { sec } of flat) {
    if (doc.title && sec.level === 1 && sec.line === doc.title.line) continue;
    const key = sec.label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { label: sec.label, occ: [] });
    groups.get(key).occ.push(sec);
  }

  for (const g of groups.values()) {
    const n = g.occ.length;
    const card = n === 1 ? 'required' : 'one-or-more';
    out.push('');
    out.push(`## ${safeLabel(g.label)} ${card}`);

    // prose: required only when every occurrence actually carries paragraphs
    const lens = g.occ.filter((s) => s.paras.length > 0).map((s) => charLen(proseText(s)));
    const allProse = g.occ.every((s) => s.paras.length > 0);
    if (lens.length > 0) {
      const pcard = allProse ? 'required' : 'optional';
      const minLen = Math.min(...lens);
      out.push('');
      out.push(minLen > 0 ? `prose ${pcard} minLength=${minLen}` : `prose ${pcard}`);
      out.push('');
      out.push('expect:');
      out.push(`  TODO: describe what the ${g.label} section must convey.`);
      out.push('');
      out.push('validate:');
      out.push('  semantic: optional');
    }

    // fields: grouped by label, typed over all observed values
    const byOcc = g.occ.map((s) => classifyBullets(s.bullets));
    const fieldLabels = new Map();
    for (const { fields } of byOcc) {
      for (const f of fields) {
        if (!fieldLabels.has(f.label)) fieldLabels.set(f.label, []);
        fieldLabels.get(f.label).push(f.value);
      }
    }
    for (const [label, values] of fieldLabels) {
      const present = byOcc.filter(({ fields }) => fields.some((f) => f.label === label)).length;
      const fcard = present === n ? 'required' : 'optional';
      const type = inferType(values);
      if (fieldLabels.keys().next().value === label) out.push('');
      out.push(`- ${label}: ${type}${fcard === 'optional' ? ' optional' : ''}`);
    }

    // plain bullet lists
    const listCounts = byOcc.map(({ list }) => list.length);
    if (listCounts.some((c) => c > 0)) {
      const allList = listCounts.every((c) => c > 0);
      const lcard = allList ? '' : ' optional';
      const minItems = Math.min(...listCounts);
      out.push('');
      out.push(
        `list string${lcard}${allList && minItems > 1 ? ` minItems=${minItems}` : ''}`,
      );
    }

    // tables grouped by column signature
    const sigs = new Map();
    for (const s of g.occ) {
      for (const t of s.tables) {
        const sig = tableSignature(t);
        if (!sigs.has(sig)) sigs.set(sig, []);
        sigs.get(sig).push(t);
      }
    }
    let tIdx = 0;
    for (const [sig, tabs] of sigs) {
      tIdx++;
      const tcard = tabs.length === n ? 'required' : 'optional';
      const cols = sig.split('|');
      const width = Math.max(...tabs.map((t) => t.columns.length));
      const types = [];
      for (let c = 0; c < width; c++) {
        const values = [];
        let empty = false;
        for (const t of tabs) {
          for (const row of t.rows) {
            const cell = row.cells[c] ?? '';
            if (cell === '') empty = true;
            else values.push(cell);
          }
        }
        types.push({ type: inferType(values), optional: empty || values.length === 0 });
      }
      const name = `${pascal([g.label])}${tIdx > 1 ? tIdx : ''}`;
      out.push('');
      out.push(`table ${name}${tcard === 'optional' ? ' optional' : ''}`);
      cols.forEach((col, i) => {
        const { type, optional } = types[i] ?? { type: 'string', optional: true };
        out.push(`- ${col}: ${type}${optional ? ' optional' : ''}`);
      });
    }

    // fenced embeds: only JSON fences are declared; other fence languages
    // stay undeclared and remain legal under the default-open contract
    const langs = new Map();
    for (const s of g.occ) {
      for (const f of s.fences) {
        if (!FENCE_LANGS.has(f.lang)) continue;
        if (!langs.has(f.lang)) langs.set(f.lang, 0);
        langs.set(f.lang, langs.get(f.lang) + 1);
      }
    }
    for (const [lang, count] of langs) {
      const ecard = count === n ? 'required' : 'optional';
      out.push('');
      out.push(`embed ${lang}${ecard === 'optional' ? ' optional' : ''}`);
    }
  }

  const schemaText = `${out.join('\n')}\n`;
  const r = await validateDocument({
    docText,
    docName,
    schemaText,
    schemaName: 'draft.mds',
    baseDir: process.cwd(),
    maxDiagnostics: null,
    enableOptionalLibs: false,
  });
  return { schemaText, exitCode: r.exitCode, stream: r.stream };
}
