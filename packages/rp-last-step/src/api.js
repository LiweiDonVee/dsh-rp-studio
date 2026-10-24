export function createRpLastStepApi(send = (...args) => globalThis.fetch(...args)) {
  async function request(action, input, signal) {
    const response = await send(new URL('api/rp-last-step/request', document.baseURI), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ action, ...input }),
    })
    let data
    try { data = await response.json() }
    catch { throw Object.assign(new Error('无法读取 RP 预设响应，请重试。'), { status: response.status }) }
    if (data?.error || !response.ok) {
      throw Object.assign(new Error(data?.error?.message || 'RP 预设请求失败，请重试。'), {
        status: response.status, code: data?.error?.code, diagnostics: data?.error?.diagnostics,
      })
    }
    return data
  }
  return {
    state: (sessionId, signal) => request('state', { sessionId }, signal),
    profile: (profileId, version, signal) => request('profile', { profileId, ...(version === undefined ? {} : { version }) }, signal),
    source: (sourceId, signal) => request('source', { sourceId }, signal),
    create: (name, expectedRevision, signal) => request('createProfile', { name, expectedRevision }, signal),
    import: (rawText, options, signal) => request('importSillyTavern', { rawText, ...options }, signal),
    save: (profile, expectedRevision, signal) => request('saveProfile', { profile, expectedRevision }, signal),
    bind: (sessionId, input, signal) => request('bindSession', { sessionId, ...input }, signal),
    preview: (profile, input, signal) => request('preview', { profile, ...input }, signal),
    migrate: (sessionId, input, signal) => request('migrate', { sessionId, ...input }, signal),
    subscribe(sessionId, onEvent, onError) {
      const url = new URL('api/rp-last-step/events', document.baseURI)
      url.searchParams.set('sessionId', sessionId ?? '')
      const source = new EventSource(url)
      for (const type of ['connected', 'changed', 'stage']) source.addEventListener(type, event => {
        let data
        try { data = JSON.parse(event.data) } catch { return }
        if (data?.sessionId === sessionId) onEvent({ ...data, type })
      })
      source.onerror = onError
      return () => source.close()
    },
  }
}
