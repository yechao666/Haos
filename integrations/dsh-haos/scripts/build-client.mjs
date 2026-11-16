import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '..');
const outputPath = resolve(packageRoot, 'lib/client.js');

const result = await build({
  entryPoints: [resolve(packageRoot, 'client-src/index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react-dom'],
  write: false,
  minify: false,
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');
const wrapped = `window.__ModuleLoader__.load({
  id: "dsh-haos",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath}`);
