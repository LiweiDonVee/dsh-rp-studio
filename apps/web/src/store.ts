import { create } from 'zustand'
import type { Card, SessionDetail, SessionSummary, StreamEvent, TranscriptMessage } from '@dsh-rp/protocol'
import { api, connectEvents } from './api.js'

type Sheet = 'campaigns' | 'inspector' | null

interface StudioState {
  cards: Card[]
  sessions: SessionSummary[]
  current: SessionDetail | null
  streaming: Record<string, string>
  loading: boolean
  connected: boolean
  error: string | null
  sheet: Sheet
  inspectorTab: 'status' | 'relationships' | 'quests' | 'timeline' | 'methods'
  promptDraftEntryIds: string[]
  promptBusy: boolean
  promptNotice: string | null
  load(): Promise<void>
  selectSession(id: string): Promise<void>
  createCampaign(cardId: string): Promise<void>
  send(text: string): Promise<void>
  cancel(): Promise<void>
  rollback(): Promise<void>
  fork(): Promise<void>
  autoplay(input: { off?: boolean; rounds?: number; objective?: string }): Promise<void>
  togglePromptEntry(entryId: string, checked: boolean): void
  togglePromptProfile(profileId: string, checked: boolean): void
  applyPromptSettings(): Promise<void>
  resetPromptSettings(): Promise<void>
  dismissError(): void
  setSheet(sheet: Sheet): void
  setInspectorTab(tab: StudioState['inspectorTab']): void
}

let disconnectStream: (() => void) | undefined
let streamNeedsResync = false
let localMessageSequence = 0
let loadRetryAttempts = 0
let loadRetryTimer: ReturnType<typeof setTimeout> | undefined
let navigationSequence = 0
const LAST_SESSION_KEY = 'dsh-rp-studio:last-session'

function rememberSession(sessionId: string): void {
  window.localStorage.setItem(LAST_SESSION_KEY, sessionId)
}

function messageFromLocal(text: string): TranscriptMessage {
  return {
    id: `local-${Date.now()}-${localMessageSequence++}`,
    seq: Number.MAX_SAFE_INTEGER,
    role: 'player',
    text,
    createdAt: Date.now(),
    status: 'complete',
  }
}

export const useStudio = create<StudioState>((set, get) => {
  function beginNavigation(): number {
    navigationSequence++
    disconnectStream?.()
    disconnectStream = undefined
    streamNeedsResync = false
    return navigationSequence
  }

  function clearLoadRetry(): void {
    if (loadRetryTimer) clearTimeout(loadRetryTimer)
    loadRetryTimer = undefined
  }

  function scheduleLoadRetry(): void {
    if (loadRetryTimer) return
    const delay = Math.min(500 * (2 ** loadRetryAttempts), 5_000)
    loadRetryAttempts++
    loadRetryTimer = setTimeout(() => {
      loadRetryTimer = undefined
      void get().load()
    }, delay)
  }

  function attachStream(id: string, sequence: number): void {
    if (sequence !== navigationSequence) return
    disconnectStream = connectEvents(id, (event) => {
      if (sequence === navigationSequence) handleEvent(event)
    }, () => {
      if (sequence !== navigationSequence) return
      streamNeedsResync = true
      set({ connected: false })
    })
  }

  async function open(id: string, sequence = beginNavigation()): Promise<void> {
    set({ loading: true, error: null, streaming: {}, sheet: null })
    try {
      const current = await api.session(id)
      if (sequence !== navigationSequence) return
      set({ current, loading: false, connected: false, promptDraftEntryIds: current.prompt?.enabledEntryIds ?? [], promptNotice: null })
      rememberSession(id)
      attachStream(id, sequence)
    } catch (error) {
      if (sequence !== navigationSequence) return
      set({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  function handleEvent(event: StreamEvent): void {
    const current = get().current
    if (!current || current.session.id !== event.sessionId) return
    if (event.type === 'connected') {
      set({ connected: true, error: null })
      if (streamNeedsResync) {
        streamNeedsResync = false
        void api.session(event.sessionId).then((detail) => {
          if (get().current?.session.id === event.sessionId) set({ current: detail, promptDraftEntryIds: detail.prompt?.enabledEntryIds ?? [] })
        }).catch((error: unknown) => {
          set({ error: error instanceof Error ? error.message : String(error) })
        })
      }
    }
    if (event.type === 'session.status') set({ current: { ...current, session: { ...current.session, running: event.running } } })
    if (event.type === 'state.updated') set({ current: { ...current, state: event.state, session: { ...current.session, state: event.state } } })
    if (event.type === 'message.delta') {
      set(state => ({ streaming: { ...state.streaming, [event.messageId]: `${state.streaming[event.messageId] ?? ''}${event.text}` } }))
    }
    if (event.type === 'message.completed') {
      const optimisticIndex = event.message.role === 'player'
        ? current.messages.findIndex(message => message.id.startsWith('local-') && message.text === event.message.text)
        : -1
      const messages = current.messages.some(message => message.id === event.message.id)
        ? current.messages.map(message => message.id === event.message.id ? event.message : message)
        : optimisticIndex >= 0
          ? current.messages.map((message, index) => index === optimisticIndex ? event.message : message)
          : [...current.messages, event.message]
      set({ current: { ...current, messages }, streaming: {} })
    }
    if (event.type === 'session.rebased') void open(event.sessionId)
    if (event.type === 'error') {
      streamNeedsResync = true
      set({ error: event.error.message, connected: false })
    }
  }

  return {
    cards: [], sessions: [], current: null, streaming: {}, loading: true,
    connected: false, error: null, sheet: null, inspectorTab: 'status',
    promptDraftEntryIds: [], promptBusy: false, promptNotice: null,
    load: async () => {
      clearLoadRetry()
      const sequence = beginNavigation()
      set({ loading: true, connected: false, error: null, streaming: {} })
      try {
        const [cards, sessions] = await Promise.all([api.cards(), api.sessions()])
        if (sequence !== navigationSequence) return
        loadRetryAttempts = 0
        set({ cards, sessions, loading: false })
        const remembered = window.localStorage.getItem(LAST_SESSION_KEY)
        const selected = sessions.find(session => session.id === remembered)
          ?? sessions.find(session => !session.blank && session.state?.started)
          ?? sessions.find(session => !session.blank)
          ?? sessions[0]
        if (selected) await open(selected.id, sequence)
      } catch (error) {
        if (sequence !== navigationSequence) return
        set({ loading: false, error: error instanceof Error ? error.message : String(error) })
        scheduleLoadRetry()
      }
    },
    selectSession: open,
    createCampaign: async (cardId) => {
      if (get().loading) return
      const sequence = beginNavigation()
      set({ loading: true, connected: false, error: null, streaming: {}, sheet: null })
      try {
        const current = await api.create(cardId)
        if (sequence !== navigationSequence) return
        set(state => ({
          current, sessions: [current.session, ...state.sessions], loading: false, connected: false,
          promptDraftEntryIds: current.prompt?.enabledEntryIds ?? [], promptNotice: null,
        }))
        rememberSession(current.session.id)
        attachStream(current.session.id, sequence)
      } catch (error) {
        if (sequence !== navigationSequence) return
        set({ loading: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
    send: async (text) => {
      const current = get().current
      if (!current || get().promptBusy) return
      set({ current: { ...current, messages: [...current.messages, messageFromLocal(text)], session: { ...current.session, running: true } }, error: null })
      try {
        await api.prompt(current.session.id, text)
      } catch (error) {
        set(state => ({
          current: state.current?.session.id === current.session.id
            ? {
                ...state.current,
                messages: state.current.messages.filter(message => !message.id.startsWith('local-') || message.text !== text),
                session: { ...state.current.session, running: false },
              }
            : state.current,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    },
    cancel: async () => {
      const current = get().current
      if (current) await api.cancel(current.session.id)
    },
    rollback: async () => {
      const current = get().current
      if (!current) return
      try { await api.rollback(current.session.id) } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }) }
    },
    fork: async () => {
      const current = get().current
      if (!current || get().loading) return
      const sequence = beginNavigation()
      set({ loading: true, connected: false, error: null, streaming: {} })
      try {
        const child = await api.fork(current.session.id)
        if (sequence !== navigationSequence) return
        set(state => ({
          sessions: [child.session, ...state.sessions], current: child, loading: false, connected: false,
          promptDraftEntryIds: child.prompt?.enabledEntryIds ?? [], promptNotice: null,
        }))
        rememberSession(child.session.id)
        attachStream(child.session.id, sequence)
      } catch (error) {
        if (sequence === navigationSequence) set({ loading: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
    autoplay: async (input) => {
      const current = get().current
      if (!current) return
      try { await api.autoplay(current.session.id, input) } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }) }
    },
    togglePromptEntry: (entryId, checked) => {
      const current = get().current
      const prompt = current?.prompt
      if (!prompt?.available) return
      const owner = prompt.optionalProfiles.find(profile => profile.entries.some(entry => entry.id === entryId))
      const entry = owner?.entries.find(item => item.id === entryId)
      if (!owner || !entry) return
      set(state => {
        const selected = new Set(state.promptDraftEntryIds)
        if (!checked) selected.delete(entryId)
        else {
          if (entry.group && entry.selection === 'single') {
            for (const candidate of owner.entries) if (candidate.group === entry.group) selected.delete(candidate.id)
          }
          selected.add(entryId)
        }
        return { promptDraftEntryIds: [...selected], promptNotice: null }
      })
    },
    togglePromptProfile: (profileId, checked) => {
      const profile = get().current?.prompt?.optionalProfiles.find(item => item.id === profileId)
      if (!profile) return
      set(state => {
        const selected = new Set(state.promptDraftEntryIds)
        const ids = new Set(profile.entries.map(entry => entry.id))
        for (const id of ids) selected.delete(id)
        if (checked) {
          const selectedSingleGroups = new Set<string>()
          for (const entry of profile.entries) {
            if (entry.group && entry.selection === 'single') {
              if (selectedSingleGroups.has(entry.group)) continue
              selectedSingleGroups.add(entry.group)
            }
            selected.add(entry.id)
          }
        }
        return { promptDraftEntryIds: [...selected], promptNotice: null }
      })
    },
    applyPromptSettings: async () => {
      const current = get().current
      const prompt = current?.prompt
      if (!current || !prompt?.available || get().promptBusy) return
      const selected = get().promptDraftEntryIds
      set({ promptBusy: true, error: null })
      try {
        const saved = await api.applyPromptSettings(current.session.id, selected, prompt.revision)
        set(state => state.current?.session.id === current.session.id
          ? {
              current: { ...state.current, prompt: saved },
              promptDraftEntryIds: saved.enabledEntryIds,
              promptBusy: false,
              promptNotice: saved.enabledEntryIds.length === 0
                ? '当前没有启用任何叙事方法；下一轮仅使用 Agent runtime 核心与卡片底座。'
                : '叙事方法已保存，将从下一轮生效。',
            }
          : { promptBusy: false })
      } catch (error) {
        set(state => state.current?.session.id === current.session.id
          ? { promptBusy: false, error: error instanceof Error ? error.message : String(error) }
          : { promptBusy: false })
      }
    },
    resetPromptSettings: async () => {
      const current = get().current
      const prompt = current?.prompt
      if (!current || !prompt?.available || get().promptBusy) return
      set({ promptBusy: true, error: null })
      try {
        const saved = await api.resetPromptSettings(current.session.id, prompt.revision)
        set(state => state.current?.session.id === current.session.id
          ? {
              current: { ...state.current, prompt: saved },
              promptDraftEntryIds: [],
              promptBusy: false,
              promptNotice: '当前没有启用任何叙事方法；下一轮仅使用 Agent runtime 核心与卡片底座。',
            }
          : { promptBusy: false })
      } catch (error) {
        set(state => state.current?.session.id === current.session.id
          ? { promptBusy: false, error: error instanceof Error ? error.message : String(error) }
          : { promptBusy: false })
      }
    },
    dismissError: () => set({ error: null }),
    setSheet: sheet => set({ sheet }),
    setInspectorTab: inspectorTab => set({ inspectorTab }),
  }
})
