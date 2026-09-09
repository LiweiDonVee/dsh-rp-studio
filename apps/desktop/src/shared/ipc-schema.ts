import { z } from 'zod'

export const runtimePathFieldSchema = z.enum(['nodeExecutable', 'dshBin', 'gatewayEntry', 'dshHome', 'runtimeRoot'])
const sessionIdSchema = z.string().trim().min(1).max(500)
const selectionIdSchema = z.string().trim().min(1).max(100)
const selectionsSchema = z.object({
  nodeExecutable: selectionIdSchema.optional(),
  dshBin: selectionIdSchema.optional(),
  gatewayEntry: selectionIdSchema.optional(),
  dshHome: selectionIdSchema.optional(),
  runtimeRoot: selectionIdSchema.optional(),
}).strict()

export const ipcRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }).strict(),
  z.object({ type: z.literal('doctor') }).strict(),
  z.object({ type: z.literal('get-settings') }).strict(),
  z.object({ type: z.literal('choose-runtime-path'), field: runtimePathFieldSchema }).strict(),
  z.object({ type: z.literal('save-settings'), selections: selectionsSchema, dshPort: z.number().int().min(0).max(65_535), studioPort: z.number().int().min(0).max(65_535) }).strict(),
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
  z.object({ type: z.literal('import-asset'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('backup-export'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('backup-import'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('subscribe-notifications'), sessionId: sessionIdSchema }).strict(),
])

const processSchema = z.object({ dsh: z.number().int().positive().optional(), studio: z.number().int().positive().optional() }).strict()
export const desktopStatusSchema = z.object({
  state: z.enum(['stopped', 'starting', 'running', 'stopping', 'error', 'unavailable']),
  studioUrl: z.string().url().optional(),
  processes: processSchema,
  lastError: z.object({ code: z.string().min(1).max(100) }).strict().optional(),
}).strict()
export const desktopDoctorSchema = z.object({
  ok: z.boolean(),
  diagnostics: z.array(z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(500) }).strict()),
}).strict()
const publicPathSchema = z.object({ selectionId: selectionIdSchema, label: z.string().min(1).max(260) }).strict()
export const publicSettingsSchema = z.object({
  selections: z.object({
    nodeExecutable: publicPathSchema.optional(), dshBin: publicPathSchema.optional(), gatewayEntry: publicPathSchema.optional(),
    dshHome: publicPathSchema.optional(), runtimeRoot: publicPathSchema.optional(),
  }).strict(),
  dshPort: z.number().int().min(0).max(65_535),
  studioPort: z.number().int().min(0).max(65_535),
}).strict()
const okSchema = z.object({ ok: z.literal(true) }).strict()
const diagnosticSchema = z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(500) }).strict()
export const backupSuccessSchema = z.object({ selected: z.literal(true), ok: z.literal(true), backupId: z.string().min(1).max(200) }).strict()
const backupSchema = z.union([
  z.object({ selected: z.literal(false) }).strict(),
  backupSuccessSchema,
  z.object({ selected: z.literal(true), ok: z.literal(false), diagnostic: diagnosticSchema }).strict(),
])
const chooserSchema = z.discriminatedUnion('selected', [
  z.object({ selected: z.literal(false) }).strict(),
  z.object({ selected: z.literal(true), selectionId: selectionIdSchema, label: z.string().min(1).max(260) }).strict(),
])
export const assetSuccessSchema = z.object({ selected: z.literal(true), ok: z.literal(true), assetId: z.string().min(1).max(200) }).strict()
const assetSchema = z.union([
  z.object({ selected: z.literal(false) }).strict(),
  assetSuccessSchema,
  z.object({ selected: z.literal(true), ok: z.literal(false), diagnostic: diagnosticSchema }).strict(),
])
const startSchema = z.object({ ok: z.literal(true), studioUrl: z.string().url() }).strict()

export type IpcRequest = z.infer<typeof ipcRequestSchema>
export type IpcRequestType = IpcRequest['type']
export type RuntimePathField = z.infer<typeof runtimePathFieldSchema>
export type DesktopStatus = z.infer<typeof desktopStatusSchema>
export type DesktopDoctor = z.infer<typeof desktopDoctorSchema>
export type PublicSettings = z.infer<typeof publicSettingsSchema>

export function parseIpcRequest(value: unknown): IpcRequest {
  return ipcRequestSchema.parse(value)
}

export function parseIpcResponse(type: IpcRequestType, value: unknown): unknown {
  const schemas: Record<IpcRequestType, z.ZodTypeAny> = {
    status: desktopStatusSchema,
    doctor: desktopDoctorSchema,
    'get-settings': publicSettingsSchema,
    'choose-runtime-path': chooserSchema,
    'save-settings': okSchema,
    start: startSchema,
    stop: okSchema,
    'import-asset': assetSchema,
    'backup-export': backupSchema,
    'backup-import': backupSchema,
    'subscribe-notifications': okSchema,
  }
  return schemas[type].parse(value)
}
