import type { ApiError } from '@dsh-rp/protocol'

export class GatewayError extends Error {
  constructor(
    readonly apiError: ApiError,
    readonly statusCode: number,
  ) {
    super(apiError.message)
  }
}
