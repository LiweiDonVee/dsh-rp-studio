import { describe, expect, it } from 'vitest';
import { runConfiguredDesktopDoctor, runDesktopDoctor } from '../src/main/desktop-doctor.js';
import type { DesktopSettings } from '../src/main/settings.js';

describe('desktop doctor', () => {
  it('combines independent Node and Supervisor diagnostics without exposing secrets', async () => {
    const result = await runDesktopDoctor(
      'C:/node.exe',
      { doctor: async () => ({ ok: false, diagnostics: [{ code: 'gateway-down' }] }) },
      async () => [{ code: 'node-version', message: 'Node 24 required', detail: 'C:/private/node.exe' }],
    );
    expect(result).toEqual({ ok: false, diagnostics: [{ code: 'node-version', message: 'Node 24 required' }, { code: 'gateway-down' }] });
  });

  it('reports incomplete runtime fields with fixed public diagnostics', async () => {
    const settings: DesktopSettings = {
      nodeExecutable: '', dshBin: '', gatewayEntry: '', dshHome: '', runtimeRoot: '', dshPort: 0, studioPort: 0,
    }
    const result = await runConfiguredDesktopDoctor(
      settings,
      { doctor: async () => ({ ok: true, diagnostics: [] }) },
      async () => ['nodeExecutable', 'dshHome'],
    )

    expect(result).toEqual({
      ok: false,
      diagnostics: [
        { code: 'nodeExecutable-invalid', message: 'Node.js 24 executable is missing or invalid' },
        { code: 'dshHome-invalid', message: 'Existing DSH home is missing or invalid' },
      ],
    })
  })
});
