declare module 'dsh-tavern-renderer/core' {
  export interface RenderResult { html: string; trace: string[]; diagnostics: unknown[] }
  export interface Renderer {
    render(input: string, context?: Record<string, unknown>): RenderResult
  }
  export function createRenderer(options?: Record<string, unknown>): Renderer
}

declare module 'dsh-tavern-renderer-styles'
