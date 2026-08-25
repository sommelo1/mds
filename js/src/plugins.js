/**
 * Discover installed plugin packages.
 *
 * Two zero-config conventions are scanned in `cwd/node_modules`:
 *   - flat packages named `mds-ext-*`
 *   - anything under the `@mds` scope (e.g. `@mds/semantic-llm`)
 *
 * Each package exports `{ id?, formats?, validators? }` using the same
 * descriptor shapes as the bundled formats; a `create()` factory is
 * honored. Discovery results are sorted by package name so output stays
 * deterministic regardless of installation order.
 *
 * @module plugins
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Candidate plugin names: `mds-ext-*` plus every `@mds/*` package. */
function pluginNames(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    if (n.startsWith('mds-ext-')) out.push(n);
    else if (n === '@mds') {
      const scope = join(dir, n);
      if (existsSync(scope)) {
        for (const sub of readdirSync(scope)) out.push(`@mds/${sub}`);
      }
    }
  }
  return out.sort();
}

/**
 * Discover installed extension packages.
 *
 * @param {string} [cwd] directory whose node_modules is scanned
 * @returns {Promise<Array<object>>} loaded extension descriptors
 */
export async function discoverPlugins(cwd = process.cwd()) {
  const dir = join(cwd, 'node_modules');
  if (!existsSync(dir)) return [];
  const names = pluginNames(dir);
  const out = [];
  for (const name of names) {
    try {
      const pkgPath = join(dir, name, 'package.json');
      let main = 'index.js';
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(pkgPath, 'utf8')));
        main = pkg.main ?? 'index.js';
      }
      const mod = await import(pathToFileURL(join(dir, name, main)).href);
      const ext = typeof mod.create === 'function' ? mod.create() : mod;
      if (ext && (Array.isArray(ext.formats) || Array.isArray(ext.validators))) out.push(ext);
    } catch (err) {
      process.stderr.write(`mds: warning: failed to load plugin ${name}: ${err?.message ?? err}\n`);
    }
  }
  return out;
}
