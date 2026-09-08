import { useMemo } from 'react'
import { createRenderer } from 'dsh-tavern-renderer/core'

const renderer = createRenderer({
  templates: {
    assistant: '<div class="dsh-tr-message-content">{{content}}</div>',
    user: '<div class="dsh-tr-message-content">{{content}}</div>',
    system: '<div class="dsh-tr-message-content">{{content}}</div>',
  },
})

export function RenderedNarrative(props: { text: string; char: string; streaming?: boolean }) {
  const html = useMemo(() => renderer.render(props.text, {
    role: 'assistant', char: props.char, user: '玩家', streaming: props.streaming === true,
  }).html, [props.text, props.char, props.streaming])
  return <div data-dsh-tavern-renderer data-dsh-tavern-renderer-version="0.2.1" dangerouslySetInnerHTML={{ __html: html }} />
}
