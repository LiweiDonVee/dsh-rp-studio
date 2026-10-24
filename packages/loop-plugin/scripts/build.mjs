import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
const file = path => fileURLToPath(new URL(path, root))
await mkdir(new URL('dist/', root), { recursive:true })
await build({entryPoints:[file('src/host.mjs')],outfile:file('dist/host.js'),bundle:true,format:'esm',platform:'node',target:'node24'})
await build({entryPoints:[file('src/client.jsx')],outfile:file('dist/client.js'),bundle:true,format:'cjs',platform:'browser',target:'es2022',jsx:'automatic',loader:{'.css':'text'},external:['react','react/jsx-runtime'],banner:{js:'window.__ModuleLoader__.load({ id: "dsh-loop-studio", factory: (require) => { var module = {exports:{}}; var exports = module.exports;'},footer:{js:'return module.exports; } });'}})
