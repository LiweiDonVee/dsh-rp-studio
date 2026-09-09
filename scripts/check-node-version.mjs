import { pathToFileURL } from 'node:url'

export const requiredNodeMajor = 24

export function assertNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version)
  if (!match) throw new Error(`Unable to parse Node.js version ${version}`)
  const major = Number(match[1])
  if (major !== requiredNodeMajor) throw new Error(`Node.js ${version} is unsupported; install Node.js 24`)
  return match.slice(1, 4).join('.')
}

export function runNodeVersionCheck() {
  const version = assertNodeVersion(process.version)
  process.stdout.write(`Node ${version} satisfies the required Node 24 runtime\n`)
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined
if (entry === import.meta.url) {
  try {
    runNodeVersionCheck()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
