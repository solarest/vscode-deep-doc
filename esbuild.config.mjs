import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

const extBase = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
};

const webviewBase = {
  entryPoints: ['webview-ui/index.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  outfile: 'dist/webview.js',
  format: 'iife',
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
};

async function main() {
  if (isWatch) {
    const extCtx = await esbuild.context(extBase);
    const webviewCtx = await esbuild.context(webviewBase);
    await extCtx.watch();
    await webviewCtx.watch();
    console.log('[esbuild] Watching for changes...');
  } else {
    await esbuild.build(extBase);
    await esbuild.build(webviewBase);
    console.log('[esbuild] Build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
