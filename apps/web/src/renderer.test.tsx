import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RenderedNarrative } from './renderer.js'

describe('Tavern narrative adapter', () => {
  it('renders Markdown while removing executable HTML', () => {
    const view = render(<RenderedNarrative char="档案主持人" text={'**粗体** <script>window.LEAK = true</script>'} />)
    expect(view.container.querySelector('strong')).toHaveTextContent('粗体')
    expect(view.container.querySelector('script')).toBeNull()
    expect(view.container).not.toHaveTextContent('window.LEAK')
  })

  it('preserves all eight Tavern document families through the Studio template', () => {
    const types = ['letter', 'exam', 'postcard', 'cipher', 'telegram', 'newspaper', 'dossier', 'diary']
    const text = types.map(type => [
      `:::${type}`,
      `title: ${type}`,
      '---',
      `**${type} body**`,
      ':::',
    ].join('\n')).join('\n\n')
    const view = render(<RenderedNarrative char="档案主持人" text={text} />)
    for (const type of types) {
      expect(view.container.querySelector(`.custom-dtr-doc-${type}`)).not.toBeNull()
    }
    expect(view.container.querySelector('.custom-dtr-doc-letter strong')).toHaveTextContent('letter body')
    expect(view.container.querySelector('.custom-dtr-doc-newspaper strong')).toHaveTextContent('newspaper body')
  })
})
