import { copyFile } from 'node:fs/promises'
await copyFile(new URL('./src/windows-tree.ps1', import.meta.url), new URL('./dist/windows-tree.ps1', import.meta.url))
