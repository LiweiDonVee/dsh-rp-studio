import type { DesktopApi } from '../preload/api.js'

declare global { var dshDesktop: Readonly<DesktopApi> | undefined }
export {}
