import {build} from 'esbuild'
import {cp,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
const root=new URL('../',import.meta.url),file=path=>fileURLToPath(new URL(path,root))
await mkdir(new URL('dist/skills/',root),{recursive:true})
await cp(new URL('../../../skills/adapting-sillytavern-rp-presets/',import.meta.url),new URL('dist/skills/adapting-sillytavern-rp-presets/',root),{recursive:true})
await build({entryPoints:[file('src/host.mjs')],outfile:file('dist/host.js'),bundle:true,platform:'node',target:'node24',format:'esm'})
await build({entryPoints:[file('src/client.jsx')],outfile:file('dist/client.js'),bundle:true,platform:'browser',target:'es2022',format:'cjs',jsx:'automatic',loader:{'.css':'text'},external:['react','react/jsx-runtime'],banner:{js:'window.__ModuleLoader__.load({id:"dsh-rp-last-step",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},footer:{js:'return module.exports;}});'}})
