// Typed errors for the services/api pipeline (docs/service-specs.md).
// createApiHandler catches these and formats them into the standard error
// response shape from docs/api-contracts.md - never a raw exception.

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const unauthorized = () =>
  new ApiError(401, "UNAUTHORIZED", "Authentication required.");

export const validationError = (message: string) =>
  new ApiError(400, "VALIDATION_ERROR", message);

export const notFound = () => new ApiError(404, "NOT_FOUND", "Not found.");
