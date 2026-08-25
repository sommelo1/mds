/**
 * Validation orchestrator implementing the normative two-phase algorithm:
 *
 * Phase A emits structural findings in *declaration* order (missing title,
 * metadata problems, absent/over-counted sections, ordering violations,
 * missing embeds). Phase B walks matched sections in *document* order and
 * checks content (prose, fields, lists, tables, embeds), delegating to
 * format extensions and recursing into embedded `.mds` contracts.
 *
 * The emission order is part of the conformance contract — the Python
 * implementation mirrors this module statement by statement.
 *
 * @module validate
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { Diagnostic, CODES, SEVERITY, renderStream } from './diagnostics.js';
import { parseDocument, normLabel, headingMatches, flattenSections } from './mddoc.js';
import { parseSchema, effectiveFlags } from './schema.js';
import { checkType, checkConstraints, describeType } from './types.js';
import { builtinFormats } from './formats/index.js';
import { discoverPlugins } from './plugins.js';

const segOf = (d) => d.id ?? d.labelNorm;
const joinSeg = (prefix, seg) => (prefix === '' || prefix === '/' ? `/${seg}` : `${prefix}/${seg}`);
const norm = (p) => (p === '/' ? '/' : p.replace(/\/+$/, '') || '/');

/* ------------------------------------------------------------------ *
 * Schema loading (use / $ref, cycles, namespaces)
 * ------------------------------------------------------------------ */

/**
 * Load a root schema plus transitive imports.
 *
 * @param {string} schemaText root source
 * @param {string} schemaName root diagnostics file name
 * @param {string} baseDir import resolution directory
 * @returns {{model:object|null, diags:Diagnostic[]}}
 */
export function loadSchema(schemaText, schemaName, baseDir) {
  const root = parseSchema(schemaText, schemaName);
  const diags = [...root.diags];
  const loaded = new Map();
  const defs = root.model.definitions;

  const walk = (model, modelFile, dir, stack) => {
    for (const imp of model.imports) {
      const target = imp.path.split('#')[0];
      const abs = resolve(dir, target);
      if (stack.includes(abs)) {
        const chain = [...stack.slice(stack.indexOf(abs)), abs].map((p) => basename(p));
        diags.push(new Diagnostic({
          code: CODES.IMPORT_CYCLE, severity: SEVERITY.ERROR, path: '/',
          file: modelFile, line: imp.line,
          message: `import cycle detected: ${chain.join(' -> ')}`,
        }));
        continue;
      }
      if (!existsSync(abs)) {
        diags.push(new Diagnostic({
          code: CODES.UNRESOLVED_REFERENCE, severity: SEVERITY.ERROR, path: '/',
          file: modelFile, line: imp.line,
          message: `unresolved reference "${imp.path}"`,
        }));
        continue;
      }
      let sub = loaded.get(abs);
      if (!sub) {
        const parsed = parseSchema(readFileSync(abs, 'utf8'), basename(abs));
        for (const d of parsed.diags) diags.push(d);
        sub = parsed.model;
        loaded.set(abs, sub);
        walk(sub, basename(abs), dirname(abs), [...stack, abs]);
      }
      const stem = basename(target).replace(/\.[^.]+$/, '');
      for (const [name, spec] of sub.definitions) {
        const key = `${stem}.${name}`;
        if (!defs.has(key)) defs.set(key, spec);
      }
    }
  };
  walk(root.model, schemaName, baseDir, [absRoot(baseDir, schemaName)]);
  return { model: root.model, diags };
}
function absRoot(baseDir, name) { return resolve(baseDir, `__root__/${name}`); }

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

function buildRegistry(builtins, plugins) {
  const reg = new Map();
  const add = (f) => {
    if (!f?.id) return;
    reg.set(f.id.toLowerCase(), f);
    for (const a of f.aliases ?? []) reg.set(String(a).toLowerCase(), f);
  };
  builtins.forEach(add);
  for (const p of plugins ?? []) for (const f of p.formats ?? []) add(f);
  return reg;
}
const lookupFormat = (reg, n) => reg.get(String(n).toLowerCase()) ?? null;

/** Flatten plugin `validators` descriptors into one list (section 21). */
function collectSemanticValidators(plugins) {
  const out = [];
  for (const p of plugins ?? []) {
    for (const v of p?.validators ?? []) {
      if (v && typeof v.validateExpect === 'function') out.push(v);
    }
  }
  return out;
}

/** Regions whose `validate: semantic: required` must be satisfiable. */
function requiresSemantic(model) {
  const holders = [model, ...declPreorder(model.sections)];
  return holders.some((h) => h.validateSem?.semantic === 'required' && h.expect != null);
}

/* ------------------------------------------------------------------ *
 * Shared pass context
 * ------------------------------------------------------------------ */

function makeCtx(model, doc, env) {
  void env;
  const meta = new Map();       // instance -> {decl}
  const counts = new Map();     // decl.line -> total matches
  const groups = new Map();     // decl.line -> instances[] in document order
  const consumed = new Set();   // instances already claimed by a declaration
  const pathMemo = new Map();

  const link = (insts, parent) => {
    for (const s of insts) { s._parent = parent; link(s.children, s); }
  };
  link(doc.sections, null);

  const flat = [];
  const rec = (insts) => { for (const s of insts) { flat.push(s); rec(s.children); } };
  rec(doc.sections);

  // Tree-aware matching (normative minimum): a declaration claims instances
  // of the same heading level anywhere in the document tree, processed in
  // declaration preorder; claimed instances are consumed so that later
  // declarations can never double-bind them.
  for (const d of declPreorder(model.sections)) {
    const hits = [];
    for (const s of flat) {
      if (consumed.has(s) || s.level !== d.level) continue;
      if (!headingMatches(d, s.label)) continue;
      consumed.add(s);
      meta.set(s, { decl: d });
      hits.push(s);
    }
    counts.set(d.line, hits.length);
    if (hits.length) groups.set(d.line, hits);
  }

  // Semantic paths follow the *document* tree: unmatched ancestors contribute
  // nothing; repeated occurrences of one declaration under the same document
  // parent carry a positional `[n]` suffix.
  const pathOf = (inst) => {
    if (pathMemo.has(inst)) return pathMemo.get(inst);
    let p = '';
    const m = meta.get(inst);
    if (m) {
      const sibs = (inst._parent ? inst._parent.children : doc.sections)
        .filter((x) => meta.get(x)?.decl === m.decl);
      const seg = segOf(m.decl) + (sibs.length > 1 ? `[${sibs.indexOf(inst) + 1}]` : '');
      const pp = inst._parent ? pathOf(inst._parent) : '';
      p = joinSeg(pp === '/' ? '' : pp, seg);
    }
    pathMemo.set(inst, p);
    return p;
  };
  for (const s of flat) if (meta.has(s)) s._path = pathOf(s);

  return {
    meta, counts, groups,
    effFor(sec) {
      const m = meta.get(sec);
      const anc = [];
      let p = sec._parent;
      while (p) { const pm = meta.get(p); if (pm) anc.unshift(pm.decl); p = p._parent; }
      return effectiveFlags(m.decl, anc, model);
    },
    effUnmatched() { return effectiveFlags(null, [], model); },
  };
}

const declPreorder = (sections, out = []) => {
  for (const d of sections) { out.push(d); declPreorder(d.children, out); }
  return out;
};

/* ------------------------------------------------------------------ *
 * Phase A
 * ------------------------------------------------------------------ */

function phaseA(doc, model, ctx, env, out) {
  const { fileName, schemaFile } = env;

  const l1 = declPreorder(model.sections).filter((d) => d.level === 1);
  if (l1.length > 0 && !doc.title) {
    out.push(diag(CODES.MISSING_TITLE, '/', fileName, 1, 1,
      'missing required document title', schemaFile, l1[0].line));
  }

  for (const bad of doc.metadata.malformed) {
    out.push(diag(CODES.METADATA_MALFORMED, '/metadata', fileName, bad.line, 1,
      `malformed metadata entry "${bad.text}"`, null, null));
  }
  if (model.additionalFields === false) {
    for (const e of doc.metadata.entries) {
      out.push(diag(CODES.METADATA_UNEXPECTED, `/metadata/${e.key}`, fileName, e.line, 1,
        `unexpected metadata key "${e.key}" under closed contract`,
        schemaFile, model.explicitDocFlags.additionalFields ?? null));
    }
  }

  for (const d of declPreorder(model.sections)) {
    const n = ctx.counts.get(d.line) ?? 0;
    const rep = representativePath(d, ctx);
    if (n === 0 && d.card === 'required' && d.id !== 'title') {
      out.push(diag(CODES.MISSING_SECTION, rep, fileName, 1, 1,
        `missing required section "${d.label}"`, schemaFile, d.line));
    } else if (n === 0 && d.card === 'one-or-more') {
      out.push(diag(CODES.TOO_FEW, rep, fileName, 1, 1,
        `section "${d.label}" requires at least one occurrence`, schemaFile, d.line));
    }
    const limit = { required: 1, optional: 1 }[d.card];
    if (limit != null && n > limit) {
      const off = nthMatch(ctx.groups.get(d.line), limit);
      out.push(diag(CODES.TOO_MANY, off?._path ?? rep, fileName, off?.line ?? 1, 1,
        `too many occurrences of "${d.label}"`, schemaFile, d.line));
    }
    // Repeated occurrences must always form one contiguous sibling group;
    // `order strict` additionally governs interleaving of different sections.
    if (n > 0) emitScopeOrder(d, ctx, env, out);
    for (const em of d.embeds) {
      if (em.card !== 'required' && em.card !== 'one-or-more') continue;
      const have = countFences(ctx.groups.get(d.line));
      if (have < 1) {
        out.push(diag(CODES.MISSING_EMBED, `${rep}/embed`, fileName, 1, 1,
          `missing required embed "${em.format}"`, schemaFile, em.line));
      }
    }
  }
}

function diag(code, path, file, line, column, message, cFile = null, cLine = null, depth = 0) {
  return new Diagnostic({ code, severity: SEVERITY.ERROR, path, file, line, column, message, contractFile: cFile, contractLine: cLine, depth });
}

function representativePath(d, ctx) {
  for (const s of ctx.groups.get(d.line) ?? []) if (s._path) return s._path;
  return `/${segOf(d)}`;
}

/** Occurrences in document order; return the nth (0-based). */
function nthMatch(hits, n) {
  const flat = [...(hits ?? [])].sort((a, b) => a.line - b.line);
  return flat[n] ?? null;
}

function countFences(scopeArr) {
  let n = 0;
  for (const s of scopeArr ?? []) n += s.fences.length;
  return n;
}

/** Emit C202 for one declaration grouped by document parent scope. */
function emitScopeOrder(d, ctx, env, out) {
  const hits = ctx.groups.get(d.line) ?? [];
  if (hits.length < 2) return;
  const byParent = new Map();
  for (const h of hits) {
    const key = h._parent ? h._parent.line : 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(h);
  }
  for (const hs of byParent.values()) {
    if (hs.length < 2) continue;
    // contiguity within this document scope: siblings between first and last hit
    const [first, last] = [hs[0].line, hs[hs.length - 1].line];
    const sibs = hs[0]._parent ? hs[0]._parent.children : env.doc.sections;
    const between = sibs.filter(
      (s) => s.line > first && s.line < last && metaDeclLine(ctx, s) !== d.line,
    );
    if (between.length > 0) {
      const offender = hs[1];
      out.push(diag(CODES.NON_CONTIGUOUS, offender._path, env.fileName, offender.line, 1,
        `repeated sections "${d.label}" are not contiguous`, env.schemaFile, d.line));
    }
  }
}

function metaDeclLine(ctx, sec) {
  const m = ctx.meta.get(sec);
  return m ? m.decl.line : null;
}

/**
 * Strict sibling-order check over the whole document tree (C201).
 * Runs once after Phase A per-section work, in document order.
 */
function emitDocumentOrderViolations(doc, model, ctx, env, out) {
  if (model.orderMode !== 'strict') return;
  const orderIx = new Map(declPreorder(model.sections).map((d, ix) => [d.line, ix]));
  const visit = (insts) => {
    let lastIx = -1;
    const reported = new Set();
    for (const s of insts) {
      const m = ctx.meta.get(s);
      if (m) {
        const ix = orderIx.get(m.decl.line);
        if (ix != null) {
          if (ix < lastIx && !reported.has(m.decl.line)) {
            reported.add(m.decl.line);
            out.push(diag(CODES.ORDER_VIOLATION, s._path, env.fileName, s.line, 1,
              `section "${m.decl.label}" out of declared order`, env.schemaFile, m.decl.line));
          } else {
            lastIx = Math.max(lastIx, ix);
          }
        }
      }
      visit(s.children);
    }
  };
  visit(doc.sections);
}

/* ------------------------------------------------------------------ *
 * Phase B helpers
 * ------------------------------------------------------------------ */

function resolveKind(spec) { let s = spec; while (s.kind === 'ref') s = s.target; return s; }

function typeFail(spec, raw) {
  const rk = resolveKind(spec);
  const described = describeType(spec);
  if (rk.kind === 'enum') return [CODES.ENUM_VIOLATION, `value "${raw}" is not one of ${described}`];
  if (rk.kind === 'union') return [CODES.UNION_NO_MATCH, `value "${raw}" matches none of ${described}`];
  return [CODES.TYPE_MISMATCH, `value "${raw}" does not match type ${described}`];
}

function push(out, code, path, file, line, message, contract, depth = 0) {
  out.push(diag(code, path, file, line, 1, message, contract?.cFile ?? null, contract?.cLine ?? null, depth));
}

/**
 * Validate one field bullet (recursing into declared object children).
 */
function checkField(f, valuePart, bullet, fPath, eff, env, out) {
  const contract = { cFile: env.schemaFile, cLine: f.line };
  if ((f.children?.length ?? 0) > 0) {
    if (valuePart !== '') {
      push(out, CODES.MALFORMED_FIELD, fPath, env.fileName, bullet.line,
        `malformed field entry "${f.label}"`, contract);
    }
    const seen = new Set();
    for (const cb of bullet.children ?? []) {
      const ci = cb.text.indexOf(':');
      const clabel = (ci === -1 ? cb.text : cb.text.slice(0, ci)).trim();
      const cval = ci === -1 ? '' : cb.text.slice(ci + 1).trim();
      const cand = f.children.find((cf) => cf.labelNorm === normLabel(clabel) || cf.id === clabel);
      if (!cand) {
        if (eff.addF === false) {
          push(out, CODES.UNEXPECTED_FIELD, `${fPath}/${clabel}`, env.fileName, cb.line,
            `unexpected field "${clabel}" under closed contract`,
            { cFile: env.schemaFile, cLine: eff.srcF ?? null });
        }
        continue;
      }
      seen.add(cand);
      checkField(cand, cval, cb, `${fPath}/${cand.id ?? cand.labelNorm}`, eff, env, out);
    }
    for (const cf of f.children) {
      if (cf.card === 'required' && !seen.has(cf)) {
        push(out, CODES.MISSING_FIELD, `${fPath}/${cf.id ?? cf.labelNorm}`, env.fileName, 1,
          `missing required field "${cf.label}"`, { cFile: env.schemaFile, cLine: cf.line });
      }
    }
    return;
  }
  if (resolveKind(f.spec).kind === 'array') {
    const elems = valuePart === '' ? [] : valuePart.split(/\s*,\s*/);
    elems.forEach((el, ix) => {
      if (!checkType(f.spec, el)) {
        push(out, CODES.TYPE_MISMATCH, `${fPath}[${ix + 1}]`, env.fileName, bullet.line,
          `value "${el}" does not match type ${describeType(resolveKind(f.spec).of)}`, contract);
      }
    });
    const cc = checkConstraints(f.constraints, valuePart, { count: elems.length });
    if (cc) push(out, CODES.COLLECTION_VIOLATION, fPath, env.fileName, bullet.line, cc, contract);
    if (f.constraints.has('unique')) {
      const seenIdx = new Map();
      for (let ix = 0; ix < elems.length; ix++) {
        if (seenIdx.has(elems[ix])) {
          push(out, CODES.COLLECTION_VIOLATION, fPath, env.fileName, bullet.line,
            `unique violated at rows ${seenIdx.get(elems[ix]) + 1} and ${ix + 1}`, contract);
          break;
        }
        seenIdx.set(elems[ix], ix);
      }
    }
    return;
  }
  if (!checkType(f.spec, valuePart)) {
    const [code, msg] = typeFail(f.spec, valuePart);
    push(out, code, fPath, env.fileName, bullet.line, msg, contract);
    return;
  }
  const cc = checkConstraints(f.constraints, valuePart, {});
  if (cc) push(out, CODES.CONSTRAINT_VIOLATION, fPath, env.fileName, bullet.line, cc, contract);
}

/* ------------------------------------------------------------------ *
 * Phase B — one matched section
 * ------------------------------------------------------------------ */

function phaseBSection(sec, decl, secPath, eff, env, out) {
  const { fileName, schemaFile } = env;

  if (decl.prose) {
    const text = sec.paras.map((p) => p.text).join('\n\n');
    if (text.trim() === '') {
      if (decl.prose.card === 'required' || decl.prose.card === 'one-or-more') {
        push(out, CODES.TOO_FEW, `${secPath}/prose`, fileName, sec.line,
          'missing required prose', { cFile: schemaFile, cLine: decl.prose.line });
      }
    } else {
      const cc = checkConstraints(decl.prose.constraints, text, {});
      if (cc) {
        push(out, CODES.CONSTRAINT_VIOLATION, `${secPath}/prose`, fileName,
          sec.paras[0]?.line ?? sec.line, cc, { cFile: schemaFile, cLine: decl.prose.line });
      }
    }
  }

  // positional content ordering (C205)
  const observed = [];
  for (const b of sec.blocks) {
    if (b.kind === 'para' && decl.prose) observed.push({ kind: 'prose', line: b.line });
    else if (b.kind === 'table') observed.push({ kind: 'table', line: b.line });
    else if (b.kind === 'fence') observed.push({ kind: 'embed', line: b.line });
  }
  let lastRank = -1; let offender = null;
  for (const o of observed) {
    const r = decl.contentDecls.findIndex((cd) => cd.kind === o.kind);
    if (r === -1) continue;
    if (r < lastRank) { offender = o; break; }
    lastRank = r;
  }
  if (offender) {
    push(out, CODES.CONTENT_ORDER, secPath, fileName, offender.line,
      `content out of declared order in "${decl.label}"`, { cFile: schemaFile, cLine: decl.line });
  }

  // bullets
  const seenTop = new Set();
  const listElems = [];
  for (const b of sec.bullets) {
    const ci = b.text.indexOf(':');
    const labelPart = ci === -1 ? null : b.text.slice(0, ci).trim();
    const valuePart = ci === -1 ? '' : b.text.slice(ci + 1).trim();
    const cand = labelPart
      ? decl.fields.find((f) => f.labelNorm === normLabel(labelPart) || f.id === labelPart)
      : null;
    if (cand) {
      seenTop.add(cand);
      checkField(cand, valuePart, b, `${secPath}/${cand.id ?? cand.labelNorm}`, eff, env, out);
      continue;
    }
    if (labelPart && eff.addF === false) {
      push(out, CODES.UNEXPECTED_FIELD, `${secPath}/${normLabel(labelPart)}`, fileName, b.line,
        `unexpected field "${labelPart}" under closed contract`,
        { cFile: schemaFile, cLine: eff.srcF ?? null });
      continue;
    }
    if (decl.list) listElems.push(b);
  }
  for (const f of decl.fields) {
    if (f.card === 'required' && !seenTop.has(f)) {
      push(out, CODES.MISSING_FIELD, `${secPath}/${f.id ?? f.labelNorm}`, fileName, 1,
        `missing required field "${f.label}"`, { cFile: schemaFile, cLine: f.line });
    }
  }
  if (decl.list) {
    const li = decl.list;
    listElems.forEach((b, ix) => {
      if (li.spec && !checkType(li.spec, b.text)) {
        const [code, msg] = typeFail(li.spec, b.text);
        push(out, code, `${secPath}/list[${ix + 1}]`, fileName, b.line, msg,
          { cFile: schemaFile, cLine: li.line });
      }
    });
    const cc = checkConstraints(li.constraints, '', { count: listElems.length });
    if (cc) push(out, CODES.COLLECTION_VIOLATION, `${secPath}/list`, fileName, li.line, cc,
      { cFile: schemaFile, cLine: li.line });
    if (li.constraints.has('unique')) {
      const seenIdx = new Map();
      for (let ix = 0; ix < listElems.length; ix++) {
        const t = listElems[ix].text;
        if (seenIdx.has(t)) {
          push(out, CODES.COLLECTION_VIOLATION, `${secPath}/list`, fileName, listElems[ix].line,
            `unique violated at rows ${seenIdx.get(t) + 1} and ${ix + 1}`,
            { cFile: schemaFile, cLine: li.line });
          break;
        }
        seenIdx.set(t, ix);
      }
    }
  }

  // tables bound positionally
  sec.tables.forEach((tbl, tix) => {
    const td = decl.tables[tix];
    if (!td) {
      if (eff.addF === false) {
        push(out, CODES.TOO_MANY, secPath, fileName, tbl.headerLine,
          `too many occurrences of table in "${decl.label}"`,
          { cFile: schemaFile, cLine: decl.line });
      }
      return;
    }
    const tPath = `${secPath}/${td.name ?? `Table[${tix + 1}]`}`;
    /** header index -> col decl */
    const colByHeader = new Map();
    tbl.columns.forEach((h, hx) => {
      const cn = normLabel(h);
      const cd = td.cols.find((c) => c.labelNorm === cn || c.id === cn);
      if (cd) colByHeader.set(hx, cd);
      else if (eff.addF === false) {
        push(out, CODES.UNDECLARED_COLUMN, `${tPath}/${cn}`, fileName, tbl.headerLine,
          `undeclared column "${cn}" under closed contract`,
          { cFile: schemaFile, cLine: eff.srcF ?? null });
      }
    });
    for (const cd of td.cols) {
      if (cd.card === 'required' && ![...colByHeader.values()].includes(cd)) {
        push(out, CODES.MISSING_FIELD, `${tPath}/${cd.id ?? cd.labelNorm}`, fileName, tbl.headerLine,
          `missing required column "${cd.label}"`, { cFile: schemaFile, cLine: cd.line });
      }
    }
    tbl.rows.forEach((row, ri) => {
      for (const [hx, cd] of colByHeader) {
        const raw = row.cells[hx] ?? '';
        if (!checkType(cd.spec, raw)) {
          const [code, msg] = typeFail(cd.spec, raw);
          push(out, code, `${tPath}[${ri + 1}]/${cd.id ?? cd.labelNorm}`, fileName, row.line, msg,
            { cFile: schemaFile, cLine: cd.line });
          continue;
        }
        const cc = checkConstraints(cd.constraints, raw, {});
        if (cc) {
          push(out, CODES.CONSTRAINT_VIOLATION, `${tPath}[${ri + 1}]/${cd.id ?? cd.labelNorm}`,
            fileName, row.line, cc, { cFile: schemaFile, cLine: cd.line });
        }
      }
    });
    const rc = checkConstraints(td.constraints, '', { count: tbl.rows.length });
    if (rc) push(out, CODES.COLLECTION_VIOLATION, tPath, fileName, tbl.headerLine, rc,
      { cFile: schemaFile, cLine: td.line });
    if (td.constraints.has('unique')) {
      const seenRows = new Map();
      for (let ri = 0; ri < tbl.rows.length; ri++) {
        const key = td.cols.map((cd) => {
          const hx = [...colByHeader.entries()].find(([, c]) => c === cd)?.[0];
          return hx != null ? (tbl.rows[ri].cells[hx] ?? '') : '';
        }).join('\u001f');
        if (seenRows.has(key)) {
          push(out, CODES.COLLECTION_VIOLATION, tPath, fileName, tbl.rows[ri].line,
            `unique violated at rows ${seenRows.get(key) + 1} and ${ri + 1}`,
            { cFile: schemaFile, cLine: td.line });
          break;
        }
        seenRows.set(key, ri);
      }
    }
  });

  // embeds bound positionally
  sec.fences.forEach((fen, fidx) => {
    const ed = decl.embeds[fidx];
    if (!ed) {
      if (eff.addF === false) {
        push(out, CODES.UNEXPECTED_EMBED, `${secPath}/embed`, fileName, fen.startLine,
          'unexpected embed under closed contract', { cFile: schemaFile, cLine: eff.srcF ?? null }, env.depthOffset + 1);
      }
      return;
    }
    const multi = decl.embeds.length > 1;
    const ePath = `${secPath}/embed${multi ? `[${fidx + 1}]` : ''}`;
    const depth = env.depthOffset + 1;
    const ext = lookupFormat(env.registry, ed.format);
    const langOk = fen.lang !== '' && (fen.lang === ed.format
      || (ext ? (ext.aliases ?? []).includes(fen.lang) : false));
    if (!langOk) {
      push(out, CODES.EMBED_FORMAT_MISMATCH, ePath, fileName, fen.startLine,
        `embedded block declares ${fen.lang || '?'}, contract expects ${ed.format}`,
        { cFile: schemaFile, cLine: ed.line }, depth);
      return;
    }
    if (ed.validation === 'required' && !(ext && ext.capabilities.syntax)) {
      push(out, CODES.EXT_UNAVAILABLE, ePath, fileName, fen.startLine,
        `required validation could not run; unavailable extension: ${ed.format} (via core)`, {}, depth);
      return;
    }
    if (ext?.capabilities?.syntax && ext.syntaxCheck) {
      const find = ext.syntaxCheck(fen.content.join('\n'));
      if (find) {
        out.push(new Diagnostic({
          code: ext.findingCode ?? 'MDS-E001', severity: SEVERITY.ERROR, path: ePath,
          file: fileName, line: fen.startLine + find.relLine, column: 1,
          message: `${find.message} (via ${ext.id})`, depth: depth + 1,
        }));
      }
    }
    if (ed.schemaRef) handleExternalContract(ed, fen, ePath, depth, env, out);
  });
}

/**
 * `.mds` references recurse through the core; foreign contracts require an
 * optional validator extension (opt-in, rule 5) — otherwise MDS-E410.
 */
function handleExternalContract(ed, fen, ePath, depth, env, out) {
  const ref = ed.schemaRef;
  if (/\.mds$/i.test(ref)) {
    const abs = resolve(env.baseDir, ref);
    if (!existsSync(abs)) {
      push(out, CODES.UNRESOLVED_REFERENCE, ePath, env.fileName, fen.startLine,
        `unresolved reference "${ref}"`, {}, depth);
      return;
    }
    const innerName = basename(abs);
    const parsedInner = parseSchema(readFileSync(abs, 'utf8'), innerName);
    const innerDoc = parseDocument(fen.content.join('\n'));
    // The inner run computes depths relative to its own document; forwarding
    // below lifts every line by the outer embed depth exactly once.
    const innerEnv = { ...env, doc: innerDoc, schemaFile: innerName, depthOffset: 0 };
    const innerDiags = [...parsedInner.diags, ...runCore(innerDoc, parsedInner.model, innerEnv)];
    for (const d0 of innerDiags) {
      const isDocFinding = d0.file === innerEnv.fileName;
      out.push(new Diagnostic({
        code: d0.code, severity: d0.severity,
        path: d0.path === '/' ? norm(ePath) : norm(joinSeg(ePath, d0.path.replace(/^\//, ''))),
        file: isDocFinding ? env.fileName : d0.file,
        line: isDocFinding ? fen.startLine + d0.line : d0.line,
        column: d0.column,
        message: d0.message,
        contractFile: d0.contractFile, contractLine: d0.contractLine,
        depth: d0.depth + depth,
      }));
    }
    return;
  }
  if (!env.jsvAvailable) {
    push(out, CODES.EXT_UNAVAILABLE, ePath, env.fileName, fen.startLine,
      'required validation could not run; unavailable extension: json-schema (via core)', {}, depth);
    return;
  }
  push(out, CODES.EMBED_CONTRACT_FAILED, ePath, env.fileName, fen.startLine,
    'external contract failed without granular findings', {}, depth);
}

/* ------------------------------------------------------------------ *
 * Semantic expectation evaluation (delegated, section 21)
 * ------------------------------------------------------------------ */

/**
 * Hand a region's `expect` text to every registered semantic validator.
 * Core never interprets the expectation itself; findings arrive as
 * extension diagnostics (`MDS-E4xx`) citing the binding line.
 */
function runSemanticExpect(out, env, holder, regionPath, regionLine, text) {
  const exp = holder.expect;
  const vs = holder.validateSem;
  if (!exp || !vs) return;
  for (const v of env.semanticValidators) {
    const findings = v.validateExpect({ path: regionPath, expect: exp, text: String(text ?? '') });
    for (const f of findings ?? []) {
      out.push(new Diagnostic({
        code: v.findingCode ?? 'MDS-E400', severity: SEVERITY.ERROR,
        path: regionPath, file: env.fileName, line: regionLine, column: 1,
        message: typeof f === 'string' ? f : f.message,
        contractFile: env.schemaFile, contractLine: vs.line,
        depth: env.depthOffset,
      }));
    }
  }
}

/* ------------------------------------------------------------------ *
 * Core driver
 * ------------------------------------------------------------------ */

function runCore(doc, model, env) {
  const ctx = makeCtx(model, doc, env);
  Object.assign(env, { ctx });
  const out = [];
  phaseA(doc, model, ctx, env, out);
  emitDocumentOrderViolations(doc, model, ctx, env, out);
  const hasL1Decl = declPreorder(model.sections).some((d) => d.level === 1);
  for (const { sec } of flattenSections(doc.sections)) {
    const m = ctx.meta.get(sec);
    if (!m) {
      const eff = ctx.effUnmatched();
      const isFreeTitle = sec.level === 1 && sec === doc.sections[0] && !hasL1Decl;
      if (eff.addS === false && !isFreeTitle) {
        const parentPath = sec._parent && sec._parent._path ? sec._parent._path : '';
        push(out, CODES.UNEXPECTED_SECTION, joinSeg(parentPath, sec.label), env.fileName, sec.line,
          `unexpected section "${sec.label}" under closed contract`,
          { cFile: env.schemaFile, cLine: eff.srcS ?? null });
      }
      continue;
    }
    phaseBSection(sec, m.decl, sec._path, ctx.effFor(sec), env, out);
    // semantic expectations bound to this section (document-level runs below)
    const text = sec.paras.map((p) => p.text).join('\n\n');
    runSemanticExpect(out, env, m.decl, sec._path, sec.line, text);
    if (m.decl.prose) {
      runSemanticExpect(out, env, m.decl.prose, `${sec._path}/prose`, sec.line, text);
    }
  }
  // document-level expectation covers the whole document text
  const docText = flattenSections(doc.sections)
    .map((f) => f.sec.paras.map((p) => p.text).join('\n\n'))
    .filter((t) => t !== '')
    .join('\n\n');
  runSemanticExpect(out, env, model, '/', 1, docText);
  return out;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Validate a Markdown document against a schema contract.
 *
 * @param {object} o arguments
 * @param {string} o.docText document source
 * @param {string} [o.docName='case.md']
 * @param {string} o.schemaText root schema source
 * @param {string} [o.schemaName='case.mds']
 * @param {string} [o.baseDir='.'] resolves imports & external contracts
 * @param {number|null} [o.maxDiagnostics=null] cap, announced with MDS-C900
 * @param {boolean} [o.enableOptionalLibs=false] opt-in ajv/jsonschema/yaml
 * @returns {Promise<{exitCode:number, stream:string}>}
 */
export async function validateDocument({
  docText,
  docName = 'case.md',
  schemaText,
  schemaName = 'case.mds',
  baseDir = '.',
  maxDiagnostics = null,
  enableOptionalLibs = false,
}) {
  const { model, diags: loadDiags } = loadSchema(schemaText, schemaName, baseDir);
  const schemaErrors = loadDiags.filter((d) => d.severity === SEVERITY.ERROR);
  if (schemaErrors.length > 0) {
    return { exitCode: 2, stream: renderStream(schemaErrors, maxDiagnostics) };
  }

  const plugins = await discoverPlugins(process.cwd());
  const registry = buildRegistry(builtinFormats(enableOptionalLibs), plugins);
  const semanticValidators = collectSemanticValidators(plugins);

  let jsvAvailable = false;
  if (enableOptionalLibs) {
    try { await import('ajv'); jsvAvailable = true; } catch { jsvAvailable = false; }
  }

  const pre = [];
  const needExt = (cap) => pre.push(new Diagnostic({
    code: CODES.EXT_UNAVAILABLE, severity: SEVERITY.ERROR, path: '/',
    file: schemaName, line: 1, column: 1,
    message: `required extension unavailable: ${cap} (via core)`,
  }));
  for (const fid of model.requires.formats) if (!registry.has(fid.toLowerCase())) needExt(fid);
  for (const sid of model.requires.schemas) {
    if (!(sid === 'json-schema' && jsvAvailable)) needExt(sid);
  }
  if (requiresSemantic(model) && semanticValidators.length === 0) needExt('semantic');

  const doc = parseDocument(docText);
  const env = {
    doc, fileName: docName, schemaFile: schemaName, baseDir,
    registry, jsvAvailable, depthOffset: 0, semanticValidators,
  };
  const diags = [...pre, ...runCore(doc, model, env)];
  const errors = diags.filter((d) => d.severity === SEVERITY.ERROR).length;
  return { exitCode: errors > 0 ? 1 : 0, stream: renderStream(diags, maxDiagnostics) };
}
