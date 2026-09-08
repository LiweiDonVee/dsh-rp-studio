import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

Object.defineProperty(Element.prototype, 'scrollTo', {
  configurable: true,
  value: vi.fn(),
})
