// Typed errors for the services/api pipeline (docs/service-specs.md).
// createApiHandler catches these and formats them into the standard error
// response shape from docs/api-contracts.md - never a raw exception.

export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  // Optional field-level detail (Reliability Unit A/F): merged-record
  // validation and safeguarded restore report WHICH fields failed, not
  // just a summary message. createApiHandler includes this in the error
  // body when present; errors without it keep the original body shape.
  fields?: FieldError[];

  constructor(status: number, code: string, message: string, fields?: FieldError[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const unauthorized = () =>
  new ApiError(401, "UNAUTHORIZED", "Authentication required.");

export const validationError = (message: string) =>
  new ApiError(400, "VALIDATION_ERROR", message);

export const notFound = () => new ApiError(404, "NOT_FOUND", "Not found.");

// 422 for a well-formed request whose resulting RECORD is invalid
// (Unit F merged-record validation) or whose state transition is refused
// (Unit A safeguarded restore) - the request shape was fine, the record
// it would produce is not. Distinct from validationError's 400, which is
// for malformed request bodies.
export const unprocessableEntity = (message: string, fields?: FieldError[]) =>
  new ApiError(422, "UNPROCESSABLE_ENTITY", message, fields);

// 409 for an idempotency token replayed with a DIFFERENT payload
// (Unit A / F-006): the create did not happen and the original record
// must not be presented as this request's result.
export const submissionConflict = () =>
  new ApiError(
    409,
    // Error code named verbatim by the design (Unit A / A.6).
    "submission_token_reused_with_different_payload",
    "This form was already submitted with different values. Review the existing record instead.",
  );
