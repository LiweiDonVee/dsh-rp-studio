import { describe, expect, it } from 'vitest';
import { validateNodeExecutable } from '../src/main/runtime-doctor.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

describe('independent Node runtime doctor', () => {
  it('rejects the Electron executable', async () => {
    await expect(validateNodeExecutable('C:/runtime/electron.exe')).resolves.toMatchObject([{ code: 'electron-runtime' }]);
  });

  it('reports a missing executable without throwing', async () => {
    await expect(validateNodeExecutable('Z:/does-not-exist/node.exe')).resolves.toMatchObject([{ code: 'node-missing' }]);
  });

  it('uses the selected child version output instead of the Electron process version', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const result = validateNodeExecutable('C:/runtime/node.exe', (() => {
      queueMicrotask(() => { child.stdout.write('v23.9.0'); child.emit('close', 0) })
      return child
    }) as never)

    await expect(result).resolves.toMatchObject([{ code: 'node-version' }])
  });

  it('rejects missing and relative executable paths before spawning', async () => {
    await expect(validateNodeExecutable('')).resolves.toMatchObject([{ code: 'node-missing' }])
    await expect(validateNodeExecutable('node')).resolves.toMatchObject([{ code: 'node-path' }])
  })
});
