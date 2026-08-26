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
const FIELD_MAX_LABEL = 48;
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Human noun per fence language for expect stubs (section 21). */
const EMBED_NOUNS = {
  mermaid: 'diagram', plantuml: 'diagram', puml: 'diagram', svg: 'diagram',
  abc: 'score', math: 'formula', latex: 'formula', tex: 'formula',
  csv: 'table data', json: 'JSON document', geojson: 'map',
  topojson: 'map', stl: 'mesh', markdown: 'document',
};
const embedNoun = (lang) => EMBED_NOUNS[lang] ?? 'content';

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

/** Strip surrounding emphasis/backticks from a bullet label. */
function cleanLabel(raw) {
  return raw.replace(/^\s*[\*_`]{1,3}/, '').replace(/[\*_`]{1,3}\s*$/, '').trim();
}

/** Split top-level bullets into field candidates and plain list items. */
function classifyBullets(items) {
  const fields = [];
  const list = [];
  for (const b of items) {
    const idx = b.text.indexOf(':');
    const okShape = idx > 0 && idx <= FIELD_MAX_LABEL && !URLISH.test(b.text);
    const label = okShape ? cleanLabel(b.text.slice(0, idx)) : '';
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

/**
 * Quote a heading label whenever its bare form could parse as grammar:
 * cardinality keywords, the `as` identifier keyword, content-statement
 * keywords or colon/quote characters.
 */
function safeLabel(label) {
  const reserved = new Set([...CARDS, 'as', 'table', 'list', 'prose', 'embed']);
  const risky = label.split(/\s+/).some((t) => reserved.has(t.toLowerCase()))
    || /[:"]/.test(label);
  return risky ? `"${label}"` : label;
}

/** Quote a title label unconditionally: titles may contain anything. */
function safeTitle(label) {
  return `"${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
    // Exact title text, never a glob: a "*" title would claim every H1 in
    // multi-chapter documents and starve all section declarations.
    out.push('');
    out.push(`# ${safeTitle(doc.title.text)} as title required`);
  }

  // --- group sections by heading level and normalized label ------------------
  // Declarations match instances of the SAME heading level anywhere in the
  // tree, so drafts emit the real marker level; grouping key includes it.
  const groups = new Map();
  const flat = flattenSections(doc.sections);
  for (const { sec } of flat) {
    if (doc.title && sec.level === 1 && sec.line === doc.title.line) continue;
    const key = `${sec.level}\u0000${sec.label.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { level: sec.level, label: sec.label, occ: [] });
    groups.get(key).occ.push(sec);
  }

  for (const g of groups.values()) {
    const n = g.occ.length;
    const card = n === 1 ? 'required' : 'one-or-more';
    out.push('');
    out.push(`${'#'.repeat(g.level)} ${safeLabel(g.label)} ${card}`);

    // --- positional content order (C205) -------------------------------------
    // C205 collapses all tables to one rank class and all embeds to another,
    // so binding is expressible iff some subset of {prose, tables, embeds}
    // appears in contiguous blocks across EVERY occurrence. Try subsets in
    // a preference ladder (tables are the most structural binding); the
    // first passing subset decides what this section declares. Sections
    // ending with [] bind presence/fields/lists only — their block content
    // stays tolerated under additionalFields.
    const kindClasses = (s) => (s.blocks ?? []).map((b) => {
      if (b.kind === 'para') return 'prose';
      if (b.kind === 'fence') return 'embeds';
      if (b.kind === 'table') return 'tables';
      return null;
    }).filter(Boolean);

    const contiguousFor = (keep) => {
      const pos = new Map();
      for (const s of g.occ) {
        pos.clear(); // per occurrence
        let i = 0;
        for (const k of kindClasses(s)) {
          if (!keep.has(k)) continue;
          if (!pos.has(k)) pos.set(k, []);
          pos.get(k).push(i++);
        }
        if ([...pos.values()].some((ps) => ps[ps.length - 1] - ps[0] + 1 !== ps.length)) {
          return false;
        }
      }
      return true;
    };
    const LADDER = [
      new Set(['prose', 'tables', 'embeds']),
      new Set(['tables', 'embeds']),
      new Set(['prose', 'tables']),
      new Set(['prose', 'embeds']),
      new Set(['tables']),
      new Set(['embeds']),
      new Set(),
    ];
    const keep = LADDER.find(contiguousFor) ?? new Set();
    const b0 = g.occ[0].blocks ?? [];
    const positions = new Map();
    kindClasses(g.occ[0]).forEach((k, i) => {
      if (!keep.has(k)) return;
      if (!positions.has(k)) positions.set(k, []);
      positions.get(k).push(i);
    });
    const rankOf = (key, tie) => (positions.get(key)?.[0] ?? Infinity) * 100 + tie;
    const chunks = [];

    // Sections the ladder leaves empty bind presence/fields/lists only.
    const contentOpen = keep.size === 0;

    // prose: required only when every occurrence actually carries paragraphs.
    const lens = (keep.has('prose'))
      ? g.occ.filter((s) => s.paras.length > 0).map((s) => charLen(proseText(s)))
      : [];
    const allProse = g.occ.every((s) => s.paras.length > 0);
    if (lens.length > 0) {
      const pcard = allProse ? 'required' : 'optional';
      const minLen = Math.min(...lens);
      chunks.push({ rank: rankOf('prose', 0), lines: [
        '',
        minLen > 0 ? `prose ${pcard} minLength=${minLen}` : `prose ${pcard}`,
        '',
        'expect:',
        `  TODO: describe what the ${g.label} section must convey.`,
        '',
        'validate:',
        '  semantic: optional',
      ] });
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
      // empty values mean missing data, not a type: infer from concrete
      // values and mark the declaration nullable (section 23.1)
      const sawEmpty = values.some((v) => v === '');
      const type = inferType(values.filter((v) => v !== ''));
      if (fieldLabels.keys().next().value === label) out.push('');
      out.push(`- ${label}: ${type}${fcard === 'optional' ? ' optional' : ''}${sawEmpty ? ' nullable' : ''}`);
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

    // tables grouped by column signature (gated by the subset ladder)
    const sigs = new Map();
    if (keep.has('tables')) {
      for (const s of g.occ) {
        for (const t of s.tables) {
          const sig = tableSignature(t);
          if (!sigs.has(sig)) sigs.set(sig, []);
          sigs.get(sig).push(t);
        }
      }
    }
    let tIdx = 0;
    for (const [sig, tabs] of sigs) {
      tIdx++;
      const tcard = tabs.length === n ? 'required' : 'optional';
      // ragged sources can yield empty header names; such columns are
      // undeclarable (the document header has no matchable text). Cells
      // keep their ORIGINAL header index while names are filtered.
      const colDefs = sig.split('|')
        .map((name, idx) => ({ name: cleanLabel(name.trim()), idx }))
        .filter((x) => x.name !== '');
      if (colDefs.length === 0) continue;
      const types = [];
      for (const { idx } of colDefs) {
        const values = [];
        let sawEmpty = false;
        for (const t of tabs) {
          for (const row of t.rows) {
            const cell = row.cells[idx] ?? '';
            if (cell === '') sawEmpty = true;
            else values.push(cell);
          }
        }
        // empty cells mean missing data → nullable, not optional
        types.push({ type: inferType(values), nullable: sawEmpty || values.length === 0 });
      }
      const name = `${pascal([g.label])}${tIdx > 1 ? tIdx : ''}`;
      chunks.push({ rank: rankOf('tables', tIdx), lines: [
        '',
        `table ${name}${tcard === 'optional' ? ' optional' : ''}`,
        ...colDefs.map(({ name: col }, i) => {
          const { type, nullable } = types[i] ?? { type: 'string', nullable: true };
          return `- ${safeLabel(col)}: ${type}${nullable ? ' nullable' : ''}`;
        }),
      ] });
    }

    // fenced embeds: bound POSITIONALLY — the validator pairs fence[i] with
    // the i-th embed declaration — so emit ONE declaration per observed
    // fence slot of the first occurrence, in document order. Every slot
    // carries an expect stub stating what it must show; a slot whose
    // language differs across occurrences binds optional.
    const f0 = keep.has('embeds') ? (g.occ[0].fences ?? []) : [];
    for (let idx = 0; idx < f0.length; idx++) {
      const lang = String(f0[idx]?.lang ?? '').toLowerCase();
      if (lang === '') continue;
      const sameEverywhere = g.occ.every((s) => {
        const f = s.fences?.[idx];
        return f != null && String(f.lang ?? '').toLowerCase() === lang;
      });
      chunks.push({ rank: rankOf('embeds', idx + 1), lines: [
        '',
        `embed ${lang}${sameEverywhere ? '' : ' optional'}`,
        '',
        'expect:',
        `  TODO: describe what the ${embedNoun(lang)} must show.`,
        '',
        'validate:',
        '  semantic: optional',
      ] });
    }

    // emit positional content in the order the document shows it
    chunks.sort((a, b) => a.rank - b.rank);
    for (const c of chunks) out.push(...c.lines);
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
