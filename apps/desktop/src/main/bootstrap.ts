import { cp, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Initializes only an empty, explicitly selected directory from bundled public release data. */
export async function bootstrapReleaseHome(home: string, releaseDirectory: string): Promise<void> {
  await mkdir(home, { recursive: true })
  if ((await readdir(home)).length !== 0) throw new Error('Select an empty directory for release initialization')
  const source = join(releaseDirectory, 'zombie-world')
  const manifest = JSON.parse(await readFile(join(source, 'rp-card.json'), 'utf8')) as { id?: string }
  if (manifest.id !== 'zombie-world') throw new Error('Bundled release preset is invalid')
  await cp(source, join(home, '.agent-presets', 'zombie-world'), { recursive: true, errorOnExist: true, force: false })
}
