import { validateNodeExecutable, type RuntimeDiagnostic } from './runtime-doctor.js'
import { validateRuntimeSettings } from './runtime-discovery.js'
import type { DesktopSettings } from './settings.js'

const fieldLabels: Record<string, string> = {
  nodeExecutable: 'Node.js 24 executable', dshBin: 'DSH entry', gatewayEntry: 'Gateway entry',
  dshHome: 'Existing DSH home', runtimeRoot: 'DSH runtime root', webDist: 'Built Studio UI',
}

export async function runConfiguredDesktopDoctor(settings: DesktopSettings, supervisor: DoctorSource, validate = validateRuntimeSettings) {
  const invalid = await validate(settings)
  const result = invalid.length ? { ok: false, diagnostics: [] } : await supervisor.doctor()
  return {
    ok: invalid.length === 0 && result.ok,
    diagnostics: [...invalid.map(field => ({ code: `${field}-invalid`, message: `${fieldLabels[field] ?? 'Runtime configuration'} is missing or invalid` })), ...result.diagnostics],
  }
}

interface DoctorSource {
  doctor(): Promise<{ ok: boolean; diagnostics: readonly unknown[] }>
}

export async function runDesktopDoctor(
  nodeExecutable: string,
  supervisor: DoctorSource,
  validate: (executable: string) => Promise<RuntimeDiagnostic[]> = validateNodeExecutable,
): Promise<{ ok: boolean; diagnostics: readonly unknown[] }> {
  const [runtimeDiagnostics, supervisorResult] = await Promise.all([
    validate(nodeExecutable),
    supervisor.doctor(),
  ])
  const diagnostics = [
    ...runtimeDiagnostics.map(({ code, message }) => ({ code, message })),
    ...supervisorResult.diagnostics,
  ]
  return { ok: diagnostics.length === 0 && supervisorResult.ok, diagnostics }
}
