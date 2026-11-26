// Build the unpacked extension into dist/.
// Pages (popup, print, offscreen) are a normal Vite build; content scripts and the service
// worker must be single self-contained files, so they are built one by one as IIFE.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const src = resolve(root, 'src/extension');
const outDir = resolve(root, 'dist');

await build({
  root: src,
  configFile: false,
  base: './',
  publicDir: resolve(root, 'public'),
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    target: 'chrome111',
    modulePreload: false,
    rollupOptions: {
      input: { popup: resolve(src, 'popup.html'), print: resolve(src, 'print.html'), offscreen: resolve(src, 'offscreen.html') },
    },
  },
});

for (const name of ['hook', 'content', 'background']) {
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome111',
      minify: false,
      lib: { entry: resolve(src, `${name}.ts`), formats: ['iife'], name: `exportForClaude_${name}`, fileName: () => `${name}.js` },
    },
  });
}

console.log(`Built extension in ${outDir}`);
