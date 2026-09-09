import { z } from 'zod'

export const PRODUCT_API_VERSION = 1 as const

export const productScopeSchema = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  cardId: z.string().min(1),
  branchId: z.string().min(1),
}).strict()

export const productPageQuerySchema = z.object({
  sessionId: z.string().min(1),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: z.enum(['portrait', 'background', 'audio', 'sticker', 'attachment']).optional(),
}).strict()

export const productAssetCategorySchema = z.enum(['portrait', 'background', 'audio', 'sticker', 'attachment'])
export const productAssetMimeSchema = z.enum([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'application/pdf',
])
export const productAssetSchema = z.object({
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  fileName: z.string().min(1).max(255),
  mimeType: productAssetMimeSchema,
  category: productAssetCategorySchema,
  label: z.string().max(500).optional(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
}).strict()
export const productAssetUploadSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  category: productAssetCategorySchema,
  label: z.string().max(500).optional(),
  contentBase64: z.string().min(1),
}).strict()
export const productAssetPatchSchema = z.object({ label: z.string().max(500).nullable() }).strict()

export const productLedgerEntrySchema = z.object({
  id: z.string().min(1),
  commandId: z.string().min(1).max(200),
  amountMinor: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  description: z.string().min(1).max(2_000),
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  reversesEntryId: z.string().min(1).optional(),
}).strict()
export const productLedgerCreateSchema = productLedgerEntrySchema.omit({ id: true, createdAt: true }).extend({ commandId: z.string().min(1).max(200) }).strict()

export const productKnowledgeSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(20_000),
  source: z.enum(['user', 'rp-projection']),
  provenance: z.object({ branchId: z.string().min(1), sourceSeq: z.number().int().nonnegative() }).strict().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()
export const productKnowledgeCreateSchema = productKnowledgeSchema.pick({ text: true }).extend({ commandId: z.string().min(1).max(200) }).strict()
export const productKnowledgePatchSchema = productKnowledgeSchema.pick({ text: true }).strict()

export const productProjectionBaseSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  sourceSeq: z.number().int().nonnegative(),
}).strict()
export const productMemorySchema = productProjectionBaseSchema.extend({
  text: z.string().min(1).max(20_000),
  emotion: z.string().max(200).optional(),
}).strict()
export const productRelationshipSchema = productProjectionBaseSchema.extend({
  subject: z.string().min(1).max(500),
  object: z.string().min(1).max(500),
  relation: z.string().min(1).max(500),
  status: z.string().max(500).optional(),
}).strict()
export const productLocationSchema = productProjectionBaseSchema.extend({
  world: z.string().min(1).max(500),
  region: z.string().max(500).optional(),
  scene: z.string().max(500).optional(),
  landmark: z.string().max(500).optional(),
}).strict()

export const productNotificationSchema = z.object({
  id: z.string().min(1),
  cursor: z.string().min(1),
  type: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  body: z.string().max(5_000),
  createdAt: z.string().datetime(),
  acknowledged: z.boolean(),
}).strict()
export const productNotificationBatchSchema = z.object({
  items: z.array(productNotificationSchema),
  cursor: z.string().min(1),
  resetRequired: z.boolean(),
  snapshot: z.array(productNotificationSchema).optional(),
}).strict()

export const productBackupSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  scope: productScopeSchema,
  createdAt: z.string().datetime(),
  state: z.enum(['staging', 'ready', 'failed']),
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  includes: z.object({ authoritativeAppData: z.literal(true), rpProjections: z.literal(true), dshSessions: z.literal(false) }).strict(),
}).strict()
export const productBackupCreateSchema = z.object({ commandId: z.string().min(1).max(200) }).strict()
export const productRestoreCommitSchema = z.object({ restoreToken: z.string().min(20).max(500) }).strict()

export const productStatusSchema = z.object({
  apiVersion: z.literal(PRODUCT_API_VERSION),
  dshCompatibility: z.literal('0.1.2-rc.1'),
  storage: z.enum(['ready', 'unavailable']),
  schemaVersion: z.number().int().positive().nullable(),
  projection: z.enum(['current', 'rebuilding', 'unavailable']),
  pairing: z.object({ enabled: z.boolean(), listener: z.enum(['loopback', 'https-lan', 'disabled']) }).strict(),
  doctor: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
}).strict()

export const pairingScopeSchema = z.enum(['product:read', 'assets:write', 'ledger:write', 'knowledge:write', 'notifications:ack'])
export const pairingSessionIdSchema = z.string().min(1).max(200)
export const pairingCodeRequestSchema = z.object({ clientName: z.string().min(1).max(100), requestedScopes: z.array(pairingScopeSchema).default([]), sessionIds: z.array(pairingSessionIdSchema).min(1).max(32) }).strict()
export const pairingConfirmSchema = z.object({ code: z.string().min(20).max(200), clientName: z.string().min(1).max(100) }).strict()
export const pairingCodeSchema = z.object({ code: z.string().min(20), expiresAt: z.string().datetime(), requestedScopes: z.array(pairingScopeSchema), sessionIds: z.array(pairingSessionIdSchema).min(1) }).strict()
export const pairingTokenSchema = z.object({ clientId: z.string().min(1), token: z.string().min(40), scopes: z.array(pairingScopeSchema), sessionIds: z.array(pairingSessionIdSchema).min(1), expiresAt: z.string().datetime() }).strict()
export const pairingClientSchema = z.object({ clientId: z.string().min(1), clientName: z.string().min(1), scopes: z.array(pairingScopeSchema), sessionIds: z.array(pairingSessionIdSchema), createdAt: z.string().datetime(), expiresAt: z.string().datetime(), revoked: z.boolean() }).strict()
export const productBootstrapSessionSchema = z.object({ sessionId: pairingSessionIdSchema, cardId: z.string().min(1), title: z.string().min(1) }).strict()
export const productBootstrapSchema = z.object({ clientId: z.string().min(1), clientName: z.string().min(1), scopes: z.array(pairingScopeSchema), expiresAt: z.string().datetime(), sessions: z.array(productBootstrapSessionSchema) }).strict()

export type ProductScope = z.infer<typeof productScopeSchema>
export type ProductPageQuery = z.infer<typeof productPageQuerySchema>
export type ProductAsset = z.infer<typeof productAssetSchema>
export type ProductAssetUpload = z.infer<typeof productAssetUploadSchema>
export type ProductAssetPatch = z.infer<typeof productAssetPatchSchema>
export type ProductLedgerEntry = z.infer<typeof productLedgerEntrySchema>
export type ProductLedgerCreate = z.infer<typeof productLedgerCreateSchema>
export type ProductKnowledge = z.infer<typeof productKnowledgeSchema>
export type ProductKnowledgeCreate = z.infer<typeof productKnowledgeCreateSchema>
export type ProductMemory = z.infer<typeof productMemorySchema>
export type ProductRelationship = z.infer<typeof productRelationshipSchema>
export type ProductLocation = z.infer<typeof productLocationSchema>
export type ProductNotification = z.infer<typeof productNotificationSchema>
export type ProductNotificationBatch = z.infer<typeof productNotificationBatchSchema>
export type ProductBackup = z.infer<typeof productBackupSchema>
export type ProductStatus = z.infer<typeof productStatusSchema>
export type PairingScope = z.infer<typeof pairingScopeSchema>
export type PairingCodeRequest = z.infer<typeof pairingCodeRequestSchema>
export type PairingClient = z.infer<typeof pairingClientSchema>
export type ProductBootstrap = z.infer<typeof productBootstrapSchema>
