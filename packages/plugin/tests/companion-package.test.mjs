import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

test('external Companion Host imports declare runtime peers for DSH linked-package resolution', async () => {
  const root = new URL('../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const source = await readFile(new URL('src/companion-agent.mjs', root), 'utf8')
  const imports = [...source.matchAll(/(?:from\s*|import\s*\(\s*)['"](@deepseek-ai\/[^/'"]+)(?:\/[^'"]*)?['"]/gu)].map(match => match[1])
  assert.ok(imports.includes('@deepseek-ai/dsh-sandbox'), 'the native approval helper remains a real Host import')
  for (const name of imports) {
    assert.equal(typeof manifest.peerDependencies?.[name], 'string', `${name} must be declared for linked Host resolution`)
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, `${name} is supplied by DSH, not separately installed`)
    assert.equal(manifest.dependencies?.[name], undefined)
    assert.equal(manifest.devDependencies?.[name], undefined)
  }
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-sandbox'], '>=0.2.1-rc.5 <0.3.0-0')
})

test('the actual pack script preserves optional Host peers in the generated tar manifest', async t => {
  const root = new URL('../', import.meta.url)
  const source = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-rp-pack-contract-'))
  const local = relative(tmpdir(), fixture)
  assert.ok(!isAbsolute(local) && !local.startsWith('..') && local.startsWith('dsh-rp-pack-contract-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  await mkdir(join(fixture, 'scripts'))
  await cp(new URL('scripts/pack.mjs', root), join(fixture, 'scripts/pack.mjs'))
  await writeFile(join(fixture, 'package.json'), JSON.stringify(source))
  for (const path of ['dist', 'skills']) await mkdir(join(fixture, path))
  // This fixture exercises packaging metadata, independently of a prior product build.
  await writeFile(join(fixture, 'dist/companion.js'), 'export const packagingFixture = true\n')
  for (const path of ['cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) await cp(new URL(path, root), join(fixture, path))
  const packed = spawnSync(process.execPath, [join(fixture, 'scripts/pack.mjs')], { encoding: 'utf8', windowsHide: true })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  const archive = join(fixture, 'artifacts', `${source.name}-${source.version}.tgz`)
  const extracted = spawnSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8', windowsHide: true })
  assert.equal(extracted.status, 0, extracted.stderr)
  const manifest = JSON.parse(extracted.stdout)
  assert.deepEqual(manifest.peerDependencies, source.peerDependencies)
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-sandbox', 'react']) assert.equal(manifest.peerDependenciesMeta[name].optional, true)
  for (const key of ['dependencies', 'devDependencies', 'scripts']) assert.equal(Object.hasOwn(manifest, key), false)
  assert.equal(manifest.exports['./companion'], './dist/companion.js')
})
