/**
 * Public library API of the MDS reference implementation (JavaScript).
 *
 * The CLI (`bin/mds.js` → `cli.js`) is a thin wrapper around this module —
 * embed the library for tooling/CI integration, use the CLI for LLM/agent
 * loops and shell pipelines (sections 46/49).
 *
 * @example
 * import { validateDocument } from 'mds-core';
 * const { exitCode, stream } = await validateDocument({
 *   docText, schemaText, docName: 'doc.md', schemaName: 'doc.mds',
 * });
 *
 * @module mds-core
 */
export { validateDocument, validateFiles, validateStreams, drainText, loadSchema } from './validate.js';
export { parseDocument, normLabel, headingMatches, flattenSections } from './mddoc.js';
export { parseSchema, effectiveFlags } from './schema.js';
export { Diagnostic, CODES, SEVERITY, renderStream, verdictOf } from './diagnostics.js';
export {
  parseType, checkType, checkConstraints, describeType, matchPattern,
  tokenizeTypeRegion,
} from './types.js';
export { builtinFormats, jsonSyntaxErrorLine } from './formats/index.js';
export { discoverPlugins } from './plugins.js';
export { inspectSchema, scaffoldDoc } from './introspect.js';
export { main as cliMain, parseArgs } from './cli.js';
