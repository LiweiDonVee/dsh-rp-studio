import { createWebAuth } from './dsh/web-auth.js'

export interface PromptProfileMetadata {
  id: string
  name: string
  version: number
  description?: string
}

export interface PromptProfileEntryView {
  id: string
  name: string
  enabled: boolean
  group?: string
  selection: 'single' | 'multiple' | 'any'
  slot: string
  tags: string[]
  renderOnly: boolean
}

export interface PromptProfileView extends PromptProfileMetadata {
  description: string
  entries: PromptProfileEntryView[]
}

export interface PromptBindingView {
  revision: number
  profileIds: string[]
  enabledEntryIds: string[]
  appliesFromNextTurn: boolean
}

export class PromptPresetsClientError extends Error {
  override readonly name = 'PromptPresetsClientError'

  constructor(message: string, readonly status = 0, readonly currentRevision?: number) {
    super(message)
  }
}

export interface PromptPresetsClient {
  catalog(): Promise<{ revision: number; profiles: PromptProfileMetadata[] }>
  profile(id: string, version?: number): Promise<PromptProfileView>
  effective(sessionId: string): Promise<PromptBindingView>
  setOverlay(sessionId: string, profileIds: string[], enabledEntryIds: string[], expectedRevision: number): Promise<PromptBindingView>
  resetOverlay(sessionId: string, expectedRevision: number): Promise<PromptBindingView>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function revision(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
}

export function assertPromptPresetsUrl(raw: string): URL {
  const url = new URL(raw)
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('Prompt Presets upstream must use an HTTP loopback URL')
  }
  return url
}

function entryView(value: unknown): PromptProfileEntryView | undefined {
  const entry = record(value)
  if (!entry || typeof entry.id !== 'string' || typeof entry.name !== 'string' || typeof entry.slot !== 'string') return undefined
  const selection = entry.selection
  if (selection !== 'single' && selection !== 'multiple' && selection !== 'any') return undefined
  return {
    id: entry.id,
    name: entry.name,
    enabled: entry.enabled !== false,
    ...(typeof entry.group === 'string' && entry.group ? { group: entry.group } : {}),
    selection,
    slot: entry.slot,
    tags: stringArray(entry.tags),
    renderOnly: entry.renderOnly === true,
  }
}

function metadata(value: unknown): PromptProfileMetadata | undefined {
  const profile = record(value)
  if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string' || !Number.isSafeInteger(profile.version) || (profile.version as number) < 1) return undefined
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version as number,
    ...(typeof profile.description === 'string' ? { description: profile.description } : {}),
  }
}

export function createPromptPresetsClient(options: {
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  webToken?: string
} = {}): PromptPresetsClient {
  const base = assertPromptPresetsUrl(options.baseUrl ?? process.env.PROMPT_PRESETS_BASE_URL ?? 'http://127.0.0.1:3091/prompt-presets/api')
  const fetchImpl = options.fetchImpl ?? fetch
  const auth = createWebAuth(base, fetchImpl, options.webToken ?? base.searchParams.get('token') ?? process.env.PROMPT_PRESETS_WEB_TOKEN)
  base.search = ''
  base.hash = ''
  const timeoutMs = options.timeoutMs ?? 3_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Prompt Presets timeout must be a positive integer')

  function endpoint(relativePath: string): URL {
    const target = new URL(base)
    const queryIndex = relativePath.indexOf('?')
    const pathname = queryIndex === -1 ? relativePath : relativePath.slice(0, queryIndex)
    const search = queryIndex === -1 ? '' : relativePath.slice(queryIndex + 1)
    target.pathname = `${base.pathname.replace(/\/+$/u, '')}/${pathname.replace(/^\/+/, '')}`
    target.search = search
    return target
  }

  async function request(relativePath: string, init?: RequestInit): Promise<Record<string, unknown>> {
    let response: Response
    try {
      const authHeaders = await auth.headers()
      response = await fetchImpl(endpoint(relativePath), {
        ...init,
        redirect: 'error',
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
        headers: {
          accept: 'application/json',
          ...authHeaders,
          ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init?.headers,
        },
      })
    } catch (error) {
      throw new PromptPresetsClientError(`Prompt Presets request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 401) {
      auth.invalidate()
      throw new PromptPresetsClientError('Prompt Presets Web authentication required', 401)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new PromptPresetsClientError('Prompt Presets returned invalid JSON', response.status)
    }
    const body = record(payload)
    if (!response.ok || body?.ok !== true) {
      throw new PromptPresetsClientError(
        typeof body?.error === 'string' ? body.error : `Prompt Presets HTTP ${response.status}`,
        response.status,
        revision(body?.currentRevision),
      )
    }
    return body
  }

  function bindingView(body: Record<string, unknown>): PromptBindingView {
    const binding = record(body.binding)
    const state = record(body.state)
    const overlay = record(binding?.overlay)
    return {
      revision: revision(body.revision ?? state?.revision),
      profileIds: stringArray(binding?.profileIds),
      enabledEntryIds: stringArray(overlay?.enabledEntries),
      appliesFromNextTurn: binding?.appliesFromNextTurn === true,
    }
  }

  return {
    catalog: async () => {
      const body = await request('catalog')
      const profiles = Array.isArray(body.profiles) ? body.profiles.flatMap(value => {
        const parsed = metadata(value)
        return parsed ? [parsed] : []
      }) : []
      return { revision: revision(body.revision), profiles }
    },
    profile: async (id, version) => {
      const suffix = version === undefined ? '' : `?version=${encodeURIComponent(String(version))}`
      const body = await request(`profiles/${encodeURIComponent(id)}${suffix}`)
      const profile = record(body.profile)
      const parsed = metadata(profile)
      if (!profile || !parsed || !Array.isArray(profile.entries)) throw new PromptPresetsClientError('Prompt profile metadata is invalid', 502)
      return {
        ...parsed,
        description: typeof profile.description === 'string' ? profile.description : '',
        entries: profile.entries.flatMap(value => {
          const entry = entryView(value)
          return entry ? [entry] : []
        }),
      }
    },
    effective: async (sessionId) => bindingView(await request(`sessions/${encodeURIComponent(sessionId)}/effective`)),
    setOverlay: async (sessionId, profileIds, enabledEntryIds, expectedRevision) => bindingView(await request(`sessions/${encodeURIComponent(sessionId)}/overlay`, {
      method: 'PUT',
      body: JSON.stringify({ profileIds, overlay: { enabledEntries: enabledEntryIds, disabledEntries: [] }, expectedRevision }),
    })),
    resetOverlay: async (sessionId, expectedRevision) => {
      const body = await request(`sessions/${encodeURIComponent(sessionId)}/overlay`, {
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision, revertToCardDefault: true }),
      })
      return { revision: revision(body.revision ?? record(body.state)?.revision), profileIds: [], enabledEntryIds: [], appliesFromNextTurn: true }
    },
  }
}
