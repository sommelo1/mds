/**
 * Deterministic Markdown instance parser producing the MDS semantic
 * document model (sections 14/15 of the specification).
 *
 * The parser intentionally implements a small, fully specified subset of
 * Markdown (ATX headings, fenced code, pipe tables, bullet lists, flat
 * front matter, paragraphs). Both reference implementations use the same
 * rules instead of a shared third-party parser so that conformance
 * fixtures yield identical models everywhere.
 *
 * @module mddoc
 */

/** Collapse whitespace runs and strip surrounding emphasis/backticks. */
export function normLabel(s) {
  let t = String(s).trim().replace(/\s+/g, ' ');
  t = t.replace(/^[_*`]+/, '').replace(/[_*`]+$/, '').trim();
  return t.replace(/\s+/g, ' ');
}

const FENCE_OPEN = /^(`{3,})(.*)$/;
const FENCE_CLOSE = /^`{3,}\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const DELIM_ROW = /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/;
const LIST_ITEM = /^(\s*)([-*+])\s+(.*)$/;

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/**
 * Parse a Markdown document into the semantic model.
 *
 * @param {string} text UTF-8 document source
 * @returns {{metadata:{entries:Array, malformed:Array}, title:({text:string,line:number}|null), sections:Array<object>, preambleLines:number}}
 */
export function parseDocument(text) {
  const lines = String(text).split(/\r?\n/);
  /** @type {{entries:Array<{key,value,line}>, malformed:Array<{line,text}>}} */
  const metadata = { entries: [], malformed: [] };
  let title = null;
  /** @type {Array<object>} */
  const rootSections = [];
  /** @type {Array<object>} */
  let stack = []; // open sections
  let cur = null; // current innermost section
  /** @type {Array<object>} */
  let bulletStack = [];

  let paraBuf = [];
  let paraLine = 0;
  const flushPara = () => {
    if (paraBuf.length && cur) {
      cur.paras.push({ text: paraBuf.join('\n'), line: paraLine });
      cur.blocks.push({ kind: 'para', line: paraLine });
    }
    paraBuf = [];
    paraLine = 0;
  };

  let i = 0;
  // --- front matter ---------------------------------------------------------
  if (lines.length > 0 && lines[0].trim() === '---') {
    let closed = false;
    for (i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { closed = true; i++; break; }
      const idx = lines[i].indexOf(':');
      if (idx === -1) metadata.malformed.push({ line: i + 1, text: lines[i].trim() });
      else metadata.entries.push({
        key: lines[i].slice(0, idx).trim(),
        value: lines[i].slice(idx + 1).trim(),
        line: i + 1,
      });
    }
    if (!closed) { // unterminated block: treat everything as normal text
      metadata.entries = [];
      metadata.malformed = [];
      i = 0;
    }
  }

  // --- body -----------------------------------------------------------------
  let fence = null; // {lang,startLine,content,contentStart}
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const ln = i + 1;

    if (fence) {
      if (FENCE_CLOSE.test(raw) && raw.match(/^`{3,}/)[0].length >= fence.ticks) {
        cur?.blocks.push({ kind: 'fence', line: fence.startLine, ref: fence.ref });
        fence = null;
      } else {
        fence.content.push(raw);
      }
      continue;
    }

    const fm = raw.match(FENCE_OPEN);
    if (fm) {
      flushPara();
      bulletStack = [];
      const info = fm[2].trim();
      const ref = { lang: (info.split(/\s+/)[0] || '').toLowerCase(), startLine: ln, content: [], ticks: fm[1].length };
      fence = ref;
      cur?.fences.push(ref);
      continue;
    }

    const hm = raw.match(HEADING);
    if (hm) {
      flushPara();
      bulletStack = [];
      const level = hm[1].length;
      const label = normLabel(hm[2]);
      const sec = {
        level, label, line: ln, paras: [], bullets: [], tables: [],
        fences: [], blocks: [], children: [],
      };
      if (!title && level === 1) title = { text: label, line: ln };
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      (stack.length ? stack[stack.length - 1].children : rootSections).push(sec);
      stack.push(sec);
      cur = sec;
      continue;
    }

    if (/^\s*\|/.test(raw)) {
      const next = lines[i + 1] ?? '';
      if (DELIM_ROW.test(next)) {
        flushPara();
        bulletStack = [];
        const tbl = {
          headerLine: ln,
          columns: splitRow(raw),
          rows: [],
        };
        i += 2; // skip header + delimiter
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          tbl.rows.push({ line: i + 1, cells: splitRow(lines[i]) });
          i++;
        }
        i--; // outer loop increments
        cur?.tables.push(tbl);
        cur?.blocks.push({ kind: 'table', line: tbl.headerLine, ref: tbl });
        continue;
      }
    }

    const lm = raw.match(LIST_ITEM);
    if (lm) {
      flushPara();
      if (cur) {
        const level = Math.floor(lm[1].replace(/\t/g, '  ').length / 2);
        const item = { text: lm[3].trim(), line: ln, level, children: [] };
        while (bulletStack.length && bulletStack[bulletStack.length - 1].level >= level) bulletStack.pop();
        (bulletStack.length ? bulletStack[bulletStack.length - 1].children : cur.bullets).push(item);
        bulletStack.push(item);
      }
      continue;
    }

    if (raw.trim() === '') { flushPara(); continue; }
    if (!cur) continue; // text before the first heading is ignored
    if (!paraBuf.length) paraLine = ln;
    paraBuf.push(raw.trim());
  }
  if (fence) { // unterminated fence: still expose content deterministically
    cur?.blocks.push({ kind: 'fence', line: fence.startLine, ref: fence });
  }
  flushPara();

  return { metadata, title, sections: rootSections };
}

/**
 * Glob-aware heading match. Only `*` is special (matches any non-empty
 * sequence); everything else is literal after normalization (section 17).
 *
 * @param {object} decl heading declaration `{label, glob}`
 * @param {string} instanceLabel normalized instance label
 * @returns {boolean}
 */
export function headingMatches(decl, instanceLabel) {
  if (!decl.glob) return decl.labelNorm === instanceLabel;
  const rx = new RegExp('^' +
    decl.label.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$');
  return rx.test(instanceLabel);
}

/** Flatten an instance section tree in document order. */
export function flattenSections(sections, out = [], parent = null) {
  for (const s of sections) {
    out.push({ sec: s, parent });
    flattenSections(s.children, out, s);
  }
  return out;
}
