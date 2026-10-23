import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
await mkdir(new URL('dist/', root), { recursive: true })
const file = path => fileURLToPath(new URL(path, root))
await build({ entryPoints: [file('src/host.ts')], outfile: file('dist/host.js'), bundle: true, platform: 'node', target: 'node24', format: 'esm', external: ['@deepseek-ai/cordis'], banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } })
await build({ entryPoints: [file('src/client.jsx')], outfile: file('dist/client.js'), bundle: true, platform: 'browser', target: 'es2022', format: 'cjs', jsx: 'automatic', loader: { '.css': 'text' }, external: ['react', 'react/jsx-runtime'],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-rp-studio", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})
