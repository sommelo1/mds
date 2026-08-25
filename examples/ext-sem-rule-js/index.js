/**
 * Example semantic-validation extension (JavaScript) — the rule-based
 * reference implementation for section 21 bindings.
 *
 * Zero-config drop-in: `node_modules/mds-ext-sem-rule`. Core only knows
 * that a semantic expectation exists and whether evaluation is required;
 * THIS package decides what "semantically acceptable" means:
 *
 *   - a region whose text is thinner than its expectation demands
 *   - leftover placeholders (TBD)
 *
 * Interface contract (mirrors formats descriptors):
 *   validators: [{ id, findingCode, validateExpect({path, expect, text}) }]
 * returning [{message}] findings that Core renders as MDS-E4xx lines.
 */
export const id = 'sem-rule';

export const validators = [{
  id: 'rule',
  findingCode: 'MDS-E450',
  /**
   * @param {{path:string, expect:string, text:string}} r
   * @returns {Array<{message:string}>}
   */
  validateExpect(r) {
    const out = [];
    const trimmed = String(r.text ?? '').trim();
    if (trimmed.length < 20) {
      out.push({
        message: `region "${r.path}" too thin for its expectation (${trimmed.length} chars)`,
      });
    }
    if (/\bTBD\b/.test(trimmed)) {
      out.push({ message: `region "${r.path}" still contains TBD` });
    }
    return out;
  },
}];

export function create() {
  return { id, validators };
}
