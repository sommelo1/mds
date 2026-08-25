/**
 * Example zero-config MDS format extension (JavaScript).
 *
 * Install layout: drop this folder as `node_modules/mds-ext-svg` next to
 * the documents you validate (or `npm i mds-ext-svg`). Discovery requires
 * NAMED exports — `export const formats = [...]` or a `create()` factory;
 * a bare default export is silently skipped.
 *
 * Binding: any `.mds` statement `embed svg …` (alias `svglite`) resolves
 * here; `validation: required` without this package yields MDS-E410.
 */
export const id = 'svg';

export const formats = [{
  id: 'svg',
  aliases: ['svglite'],
  findingCode: 'MDS-E201',
  capabilities: { syntax: true },
  /**
   * Minimal sanity check: every non-empty line outside the closing tag
   * must start with '<'.
   * @param {string} content fenced block content
   * @returns {{relLine:number,message:string}|null}
   */
  syntaxCheck(content) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t !== '' && t !== '</svg>' && !t.startsWith('<')) {
        return { relLine: i, message: 'invalid SVG element' };
      }
    }
    return null;
  },
}];

export function create() {
  return { id, formats };
}
