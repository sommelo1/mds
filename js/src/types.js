/**
 * MDS native type system: type-spec parsing, scalar recognition and
 * constraint evaluation (sections 23/24/29, encodings from section 23).
 *
 * All recognizers are deliberately hand-rolled instead of library based so
 * that the JavaScript and Python reference implementations behave
 * byte-identically — a requirement of the Conformance Invariant (section 60).
 *
 * @module types
 */

const RE = {
  integer: /^[+-]?\d+$/,
  number: /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/,
  boolean: /^(true|false)$/,
  nullish: /^(|null)$/,
  date: /^(\d{4})-(\d{2})-(\d{2})$/,
  time: /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/,
  datetime:
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/,
  duration:
    /^P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(?:\.\d+)?S)?)?$/,
  uri: /^[A-Za-z][A-Za-z0-9+\-.]*:\S+$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  binary: /^[A-Za-z0-9+/]*={0,2}$/,
};

export const SCALARS = new Set([
  'string', 'integer', 'number', 'boolean', 'null', 'date', 'datetime',
  'time', 'duration', 'uri', 'uuid', 'binary', 'any',
]);

/** Constraint keys expecting numeric values. */
const NUMERIC_CONSTRAINTS = new Set([
  'minLength', 'maxLength', 'min', 'max', 'exclusiveMin', 'exclusiveMax',
  'multipleOf', 'minItems', 'maxItems',
]);

/**
 * Split a bracket-aware type expression into tokens.
 * `union[string, number]` stays one token; `string required min=0` splits.
 *
 * @param {string} s raw type region of a declaration
 * @returns {string[]} tokens
 */
export function tokenizeTypeRegion(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ' ' && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Parse a type expression into a spec tree.
 *
 * @param {string} expr e.g. `integer`, `string[]`, `map[string]`,
 *                      `enum[draft, review]`, `union[string, number]`,
 *                      or a name introduced by `define`
 * @param {Map<string,*>} definitions reusable `define` specs
 * @returns {{ok:true, spec:object}|{ok:false,error:string}}
 */
export function parseType(expr, definitions = new Map()) {
  const e = expr.trim();
  if (definitions.has(e)) return { ok: true, spec: { kind: 'ref', name: e, target: definitions.get(e) } };
  if (SCALARS.has(e)) return { ok: true, spec: { kind: 'scalar', name: e } };
  if (e.endsWith('[]')) {
    const inner = parseType(e.slice(0, -2), definitions);
    return inner.ok ? { ok: true, spec: { kind: 'array', of: inner.spec } } : inner;
  }
  const m = e.match(/^(map|enum|union)\[([\s\S]*)\]$/);
  if (m) {
    const kind = m[1];
    const parts = splitTop(m[2]);
    if (kind === 'map') {
      if (parts.length !== 1) return { ok: false, error: `map needs exactly one value type: "${e}"` };
      const inner = parseType(parts[0], definitions);
      return inner.ok ? { ok: true, spec: { kind: 'map', of: inner.spec } } : inner;
    }
    if (kind === 'enum') {
      if (parts.length === 0) return { ok: false, error: `empty enum: "${e}"` };
      return { ok: true, spec: { kind: 'enum', values: parts } };
    }
    const alts = [];
    for (const p of parts) {
      const inner = parseType(p, definitions);
      if (!inner.ok) return inner;
      alts.push(inner.spec);
    }
    return { ok: true, spec: { kind: 'union', of: alts } };
  }
  return { ok: false, error: `unknown type "${e}"` };
}

/** Split on commas at bracket depth 0, trimming each part. */
function splitTop(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((x) => x.length > 0);
}

/** Days in month including the Gregorian leap rule (section 23 encodings). */
function daysInMonth(y, m) {
  const dm = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) return 29;
  return dm[m - 1];
}

/**
 * Check a raw string value against a parsed type spec.
 *
 * @param {object} spec parsed type spec
 * @param {string} raw raw value (already normalized; empty string = null)
 * @returns {boolean}
 */
export function checkType(spec, raw) {
  switch (spec.kind) {
    case 'ref':
      return checkType(spec.target, raw);
    case 'any':
      return true;
    case 'scalar':
      return checkScalar(spec.name, raw);
    case 'enum':
      return spec.values.includes(raw);
    case 'array':
    case 'map':
      return checkType(spec.of, raw);
    case 'union':
      // Inside a union, a bare `string` alternative matches only values that
      // are not recognizable as another native scalar type — otherwise it
      // would swallow every alternative (normative union semantics).
      return spec.of.some((alt) => {
        const rk = alt.kind === 'ref' ? alt.target : alt;
        if (rk.kind === 'scalar' && rk.name === 'string') {
          return inferPrimitive(raw) === 'string';
        }
        return checkType(alt, raw);
      });
    default:
      return false;
  }
}

/**
 * Infer the most specific native scalar kind of a raw value. Used by union
 * matching so that bare `string` alternatives only catch plain text.
 */
function inferPrimitive(raw) {
  if (RE.nullish.test(raw)) return 'null';
  if (RE.integer.test(raw)) return 'integer';
  if (RE.number.test(raw)) return 'number';
  if (RE.boolean.test(raw)) return 'boolean';
  if (RE.date.test(raw) && checkScalar('date', raw)) return 'date';
  if (RE.time.test(raw) && checkScalar('time', raw)) return 'time';
  if (RE.datetime.test(raw) && checkScalar('datetime', raw)) return 'datetime';
  if (RE.uuid.test(raw)) return 'uuid';
  if (RE.duration.test(raw)) return 'duration';
  return 'string';
}

function checkScalar(name, raw) {
  switch (name) {
    case 'string': return true;
    case 'any': return true;
    case 'null': return RE.nullish.test(raw);
    case 'integer': return RE.integer.test(raw);
    case 'number': return RE.number.test(raw);
    case 'boolean': return RE.boolean.test(raw);
    case 'binary': return RE.binary.test(raw);
    case 'uuid': return RE.uuid.test(raw);
    case 'uri': return RE.uri.test(raw);
    case 'time': {
      const m = raw.match(RE.time);
      if (!m) return false;
      return +m[1] <= 23 && +m[2] <= 59 && +m[3] <= 60;
    }
    case 'date': {
      const m = raw.match(RE.date);
      if (!m) return false;
      const y = +m[1]; const mo = +m[2]; const d = +m[3];
      return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
    }
    case 'datetime': {
      const m = raw.match(RE.datetime);
      if (!m) return false;
      const mo = +m[2]; const d = +m[3];
      return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(+m[1], mo)
        && +m[4] <= 23 && +m[5] <= 59 && +m[6] <= 60;
    }
    case 'duration':
      return RE.duration.test(raw);
    default:
      return false;
  }
}

/**
 * Human name used inside diagnostic messages for a spec.
 * References resolve to their target's name so both engines agree.
 */
export function describeType(spec) {
  if (spec.kind === 'ref') return describeType(spec.target);
  if (spec.kind === 'scalar') return spec.name;
  if (spec.kind === 'enum') return `enum[${spec.values.join(', ')}]`;
  if (spec.kind === 'union') return `union[${spec.of.map(describeType).join(', ')}]`;
  if (spec.kind === 'array') return `${describeType(spec.of)}[]`;
  if (spec.kind === 'map') return `map[${describeType(spec.of)}]`;
  return 'any';
}

/**
 * Evaluate declared constraints against a raw value.
 *
 * @param {Map<string,string>} constraints parsed `key=value` map
 * @param {string} raw raw value
 * @param {object} [ctx] collection context: `{count, dupPair}` for
 *        minItems/maxItems/unique evaluated by the caller
 * @returns {string|null} violation message or null
 */
export function checkConstraints(constraints, raw, ctx = {}) {
  for (const [k, v] of constraints) {
    if (k === 'default' || k === 'unique') continue;
    if (NUMERIC_CONSTRAINTS.has(k)) {
      const r = checkNumericConstraint(k, v, raw, ctx);
      if (r) return r;
      continue;
    }
    if (k === 'pattern') {
      if (!matchPattern(v, raw)) return `pattern="${v}" violated by "${raw}"`;
      continue;
    }
    if (k === 'const') {
      if (raw !== v) return `value "${raw}" does not equal const "${v}"`;
      continue;
    }
  }
  return null;
}

function checkNumericConstraint(k, v, raw, ctx) {
  const lim = Number(v);
  if (!Number.isFinite(lim)) return null; // parse-time validated elsewhere
  if (k === 'minLength' || k === 'maxLength') {
    const n = [...raw].length;
    if (k === 'minLength' && n < lim) return `minLength=${v} violated (${n})`;
    if (k === 'maxLength' && n > lim) return `maxLength=${v} violated (${n})`;
    return null;
  }
  if (k === 'minItems' || k === 'maxItems') {
    const n = ctx.count ?? 0;
    if (k === 'minItems' && n < lim) return `minItems=${v} violated (${n})`;
    if (k === 'maxItems' && n > lim) return `maxItems=${v} violated (${n})`;
    return null;
  }
  const x = Number(raw);
  if (!RE.number.test(raw)) return null; // type error reported separately
  if (k === 'min' && x < lim) return `min=${v} violated by "${raw}"`;
  if (k === 'max' && x > lim) return `max=${v} violated by "${raw}"`;
  if (k === 'exclusiveMin' && x <= lim) return `exclusiveMin=${v} violated by "${raw}"`;
  if (k === 'exclusiveMax' && x >= lim) return `exclusiveMax=${v} violated by "${raw}"`;
  if (k === 'multipleOf' && Math.abs(x / lim - Math.round(x / lim)) > 1e-9) {
    return `multipleOf=${v} violated by "${raw}"`;
  }
  return null;
}

/**
 * Compile-and-match a pattern. Patterns MUST be written in the common
 * subset of ECMAScript RegExp and Python `re` (see README limitations).
 *
 * @param {string} pattern source pattern
 * @param {string} value subject
 * @returns {boolean}
 */
export function matchPattern(pattern, value) {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

/**
 * Validate a `key=value` constraint pair at schema-parse time.
 *
 * @param {string} key constraint name
 * @param {string} value raw value
 * @returns {string|null} error text or null when acceptable
 */
export function validateConstraintValue(key, value) {
  if (key === 'pattern' || key === 'const' || key === 'default') {
    if (value === '') return `empty value for constraint "${key}"`;
    return null;
  }
  if (key === 'unique') return null; // flag-style
  if (NUMERIC_CONSTRAINTS.has(key)) {
    return Number.isFinite(Number(value)) && value !== ''
      ? null
      : `constraint "${key}" needs a number, got "${value}"`;
  }
  return `unknown constraint "${key}"`;
}
