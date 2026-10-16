export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notFound(message = "Resource not found") {
  return new ApiError(404, "not_found", message);
}

export function methodNotAllowed(allowed) {
  return new ApiError(
    405,
    "method_not_allowed",
    "The requested method is not supported",
    { allowed }
  );
}
