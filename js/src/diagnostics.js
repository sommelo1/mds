/**
 * Diagnostic model, code registry and the normative line-based rendering.
 *
 * Implements MDS specification v0.13, sections 46 and Annex B/D:
 * every diagnostic is one Markdown list item
 * (`[indent]- CODE severity path file:line:col [contract file:line] message`),
 * the stream ends with a blank line and a `summary:` paragraph.
 *
 * @module diagnostics
 */

/** Severity levels, section 46. */
export const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
});

/**
 * Normative Core diagnostic registry (Annex D) plus the extension codes
 * emitted by the bundled extensions (`MDS-E###`).
 * Codes are stable; never repurpose an existing one.
 */
export const CODES = Object.freeze({
  // MDS-C0xx — schema contract
  SCHEMA_SYNTAX: 'MDS-C001',
  SCHEMA_UNKNOWN_STATEMENT: 'MDS-C002',
  SCHEMA_UNKNOWN_TYPE: 'MDS-C003',
  SCHEMA_BAD_CONSTRAINT_TARGET: 'MDS-C004',
  SCHEMA_BAD_CONSTRAINT_VALUE: 'MDS-C005',
  SCHEMA_BAD_PATTERN: 'MDS-C006',
  // MDS-C1xx — document and section structure
  MISSING_SECTION: 'MDS-C101',
  UNEXPECTED_SECTION: 'MDS-C102',
  MISSING_TITLE: 'MDS-C103',
  // MDS-C2xx — cardinality and ordering
  ORDER_VIOLATION: 'MDS-C201',
  NON_CONTIGUOUS: 'MDS-C202',
  TOO_FEW: 'MDS-C203',
  TOO_MANY: 'MDS-C204',
  CONTENT_ORDER: 'MDS-C205',
  MISSING_FIELD: 'MDS-C206',
  UNEXPECTED_FIELD: 'MDS-C207',
  COMPOSITION_VIOLATION: 'MDS-C208',
  // MDS-C3xx — types and constraints
  TYPE_MISMATCH: 'MDS-C301',
  CONSTRAINT_VIOLATION: 'MDS-C302',
  ENUM_VIOLATION: 'MDS-C303',
  UNION_NO_MATCH: 'MDS-C304',
  COLLECTION_VIOLATION: 'MDS-C305',
  MALFORMED_FIELD: 'MDS-C306',
  UNDECLARED_COLUMN: 'MDS-C307',
  BAD_CELL: 'MDS-C308',
  // MDS-C4xx — references and definitions
  UNRESOLVED_REFERENCE: 'MDS-C401',
  IMPORT_CYCLE: 'MDS-C402',
  NAME_COLLISION: 'MDS-C403',
  DUPLICATE_DEFINITION: 'MDS-C404',
  // MDS-C5xx — embeds
  MISSING_EMBED: 'MDS-C501',
  UNEXPECTED_EMBED: 'MDS-C502',
  EMBED_FORMAT_MISMATCH: 'MDS-C503',
  EMBED_FORMAT_FAILED: 'MDS-C504',
  EMBED_CONTRACT_FAILED: 'MDS-C505',
  // MDS-C6xx — metadata
  METADATA_MALFORMED: 'MDS-C601',
  METADATA_TYPE: 'MDS-C602',
  METADATA_UNEXPECTED: 'MDS-C603',
  // cross-cutting
  TRUNCATED: 'MDS-C900',
  // bundled extension codes
  EXT_JSON_SYNTAX: 'MDS-E001',
  EXT_UNAVAILABLE: 'MDS-E410',
});

/**
 * One structured diagnostic finding.
 */
export class Diagnostic {
  /**
   * @param {object} o
   * @param {string} o.code            registry code, e.g. `MDS-C101`
   * @param {string} o.severity        one of {@link SEVERITY}
   * @param {string} o.path            semantic path, `/` is the document root
   * @param {string} o.file            document (or schema) file name
   * @param {number} o.line            1-based line of the finding
   * @param {number} [o.column=1]      1-based column of the finding
   * @param {string} o.message         human-readable message (last field)
   * @param {string|null} [o.contractFile] schema file driving the check
   * @param {number|null} [o.contractLine] schema line driving the check
   * @param {number} [o.depth=0]       delegation depth; rendered as indentation
   */
  constructor(o) {
    this.code = o.code;
    this.severity = o.severity;
    this.path = o.path || '/';
    this.file = o.file;
    this.line = o.line;
    this.column = o.column ?? 1;
    this.message = o.message;
    this.contractFile = o.contractFile ?? null;
    this.contractLine = o.contractLine ?? null;
    this.depth = o.depth ?? 0;
  }

  /** Render as one Markdown list item (Annex D grammar). */
  render() {
    const indent = '  '.repeat(this.depth);
    let s = `${indent}- ${this.code} ${this.severity} ${this.path} ${this.file}:${this.line}:${this.column}`;
    if (this.contractFile != null) {
      s += ` contract ${this.contractFile}:${this.contractLine}`;
    }
    return `${s} ${this.message}`;
  }

  /**
   * Plain-object form for programmatic consumption (returned alongside the
   * rendered stream). Keys are camelCase and identical across the
   * JavaScript and Python implementations.
   * @returns {object}
   */
  toObject() {
    return {
      code: this.code,
      severity: this.severity,
      path: this.path,
      file: this.file,
      line: this.line,
      column: this.column,
      message: this.message,
      contractFile: this.contractFile,
      contractLine: this.contractLine,
      depth: this.depth,
    };
  }
}

/**
 * Render the complete diagnostic stream for a run.
 *
 * Applies the optional truncation cap (announced with `MDS-C900`) and always
 * terminates with a blank line plus the `summary:` paragraph. A truncated
 * run cannot certify error totals — hidden findings may include errors — so
 * the summary reports `0 errors` and surfaces the cut as one extra warning.
 * The exit code is derived from the full, untruncated diagnostic list
 * elsewhere and is unaffected by this rendering rule.
 *
 * @param {Diagnostic[]} diags ordered findings
 * @param {number|null} [max] cap on rendered diagnostic lines
 * @returns {string} multi-line UTF-8 text without trailing newline
 */
export function renderStream(diags, max = null) {
  const shown = diags.slice();
  let truncated = false;
  if (max != null && max >= 0 && shown.length > max) {
    shown.length = max;
    truncated = true;
  }
  const lines = shown.map((d) => d.render());
  if (truncated) {
    lines.push(
      new Diagnostic({
        code: CODES.TRUNCATED,
        severity: SEVERITY.WARNING,
        path: '/',
        file: '-',
        line: 1,
        message: `diagnostic list truncated (--max ${max})`,
      }).render(),
    );
  }
  const errors = truncated ? 0 : shown.filter((d) => d.severity === SEVERITY.ERROR).length;
  const warnings = shown.filter((d) => d.severity === SEVERITY.WARNING).length + (truncated ? 1 : 0);
  lines.push('', `summary: ${errors} errors, ${warnings} warnings`);
  return lines.join('\n');
}

/** Verdict word used by the conformance fixtures and CLI plumbing. */
export function verdictOf(hasErrors) {
  return hasErrors ? 'invalid' : 'valid';
}
