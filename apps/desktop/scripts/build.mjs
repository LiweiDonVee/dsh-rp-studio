import { copyFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()

async function run(script, args) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', windowsHide: true })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  if (code !== 0) throw new Error(`${script} exited with ${code}`)
}

await run(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ['-p', 'tsconfig.json', '--noEmit'])
await run(join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), ['src/main/main.ts', '--bundle', '--platform=node', '--format=esm', '--external:electron', '--external:@dsh-rp/supervisor', '--external:zod', '--outfile=dist/main/main.js'])
await run(join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), ['src/preload/preload.ts', '--bundle', '--platform=node', '--format=cjs', '--external:electron', '--outfile=dist/preload/preload.cjs'])
await mkdir(join(root, 'dist', 'renderer'), { recursive: true })
await mkdir(join(root, 'dist', 'assets'), { recursive: true })
await Promise.all(['index.html', 'renderer.js'].map(file => copyFile(join(root, 'src', 'renderer', file), join(root, 'dist', 'renderer', file))))
await copyFile(join(root, 'assets', 'tray-icon.svg'), join(root, 'dist', 'assets', 'tray-icon.svg'))
