export class LocalDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

export class DataValidationError extends LocalDataError {}
export class DataConflictError extends LocalDataError {}
export class DataIntegrityError extends LocalDataError {}
export class StoreClosedError extends LocalDataError {}
