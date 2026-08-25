/**
 * Introspection and generation over schema contracts (sections 47/48):
 * machine-readable inspection reports and Markdown skeleton generation.
 *
 * Pure library functions — no argv handling, no process I/O. The CLI
 * (`cli.js`) is a thin wrapper around these plus {@link module:validate}.
 *
 * @module introspect
 */
import { loadSchema } from './validate.js';

/** Render an indented `expect:` block into an introspection report. */
function pushExpect(out, indent, text) {
  if (!text) return;
  out.push(`${indent}- expect:`);
  for (const l of String(text).split('\n')) out.push(`${indent}      ${l}`);
}

/** Render a region's validate binding, if any. */
function pushValidate(out, indent, holder) {
  if (!holder.validateSem) return;
  out.push(`${indent}- validate semantic: ${holder.validateSem.semantic}`);
}

/**
 * Render an introspection report (Markdown list) for a schema.
 *
 * @param {string} schemaText raw `.mds` source
 * @param {string} [schemaName='schema.mds'] file name used in diagnostics
 * @param {string} [baseDir=process.cwd()] resolves schema imports
 * @returns {{exitCode:number, stream:string}}
 */
export function inspectSchema(schemaText, schemaName = 'schema.mds', baseDir = process.cwd()) {
  const { model, diags } = loadSchema(schemaText, schemaName, baseDir);
  if (diags.some((d) => d.severity === 'error')) {
    return { exitCode: 2, stream: diags.map((d) => d.render()).join('\n') };
  }
  const out = [];
  out.push(`- document: ${model.documentName ?? '(unnamed)'}`);
  out.push(`- order: ${model.orderMode}`);
  out.push(`- additionalSections: ${model.additionalSections}`);
  out.push(`- additionalFields: ${model.additionalFields}`);
  pushExpect(out, '', model.expect);
  pushValidate(out, '', model);
  const walk = (heads, indent) => {
    for (const h of heads) {
      const card = h.card === 'required' ? '' : ` [${h.card}]`;
      out.push(`${indent}- ## ${h.label}${card}`);
      pushExpect(out, `${indent}  `, h.expect);
      pushValidate(out, `${indent}  `, h);
      if (h.prose) {
        out.push(`${indent}  - prose ${h.prose.card}`);
        pushExpect(out, `${indent}    `, h.prose.expect);
        pushValidate(out, `${indent}    `, h.prose);
      }
      if (h.list) {
        out.push(`${indent}  - list ${h.list.typeExpr} ${h.list.card}`.trimEnd());
        pushExpect(out, `${indent}    `, h.list.expect);
        pushValidate(out, `${indent}    `, h.list);
      }
      for (const t of h.tables) {
        out.push(`${indent}  - table ${t.name ?? '(anon)'} (${t.cols.map((c) => c.label).join(', ')})`);
        pushExpect(out, `${indent}    `, t.expect);
        for (const c of t.cols) {
          if (c.expect) {
            out.push(`${indent}    - column ${c.label}:`);
            pushExpect(out, `${indent}      `, c.expect);
          }
        }
      }
      for (const e of h.embeds) {
        out.push(`${indent}  - embed ${e.format} ${e.card}`);
        pushExpect(out, `${indent}    `, e.expect);
      }
      for (const f of h.fields) {
        out.push(`${indent}  - field ${f.id ?? f.label}: ${f.typeExpr} ${f.card}`.trimEnd());
        pushExpect(out, `${indent}    `, f.expect);
      }
      walk(h.children, `${indent}    `);
    }
  };
  walk(model.sections, '');
  return { exitCode: 0, stream: out.join('\n') };
}

/**
 * Generate a Markdown skeleton satisfying the section structure.
 *
 * @param {string} schemaText raw `.mds` source
 * @param {string} [schemaName='schema.mds'] file name used in diagnostics
 * @param {string} [baseDir=process.cwd()] resolves schema imports
 * @returns {{exitCode:number, stream:string}}
 */
export function scaffoldDoc(schemaText, schemaName = 'schema.mds', baseDir = process.cwd()) {
  const { model, diags } = loadSchema(schemaText, schemaName, baseDir);
  if (diags.some((d) => d.severity === 'error')) {
    return { exitCode: 2, stream: diags.map((d) => d.render()).join('\n') };
  }
  const out = [];
  const hashes = (n) => '#'.repeat(n);
  const walk = (heads) => {
    for (const h of heads) {
      out.push('');
      const label = h.glob ? '<Title>' : h.label;
      out.push(`${hashes(h.level)} ${label}`);
      out.push('');
      if (h.prose) out.push('...');
      if (h.list) out.push('- ...');
      for (const t of h.tables) {
        out.push('');
        out.push(`| ${t.cols.map((c) => c.label).join(' | ')} |`);
        out.push(`|${t.cols.map(() => '---').join('|')}|`);
      }
      for (const e of h.embeds) {
        out.push('');
        out.push(`\`\`\`${e.format}`);
        out.push('...');
        out.push('```');
      }
      for (const f of h.fields) {
        if ((f.children?.length ?? 0) === 0 && f.card !== 'zero-or-more') {
          out.push(`- ${f.label}: `);
        }
      }
      walk(h.children);
    }
  };
  walk(model.sections);
  return { exitCode: 0, stream: out.join('\n').replace(/^\n+/, '') };
}
