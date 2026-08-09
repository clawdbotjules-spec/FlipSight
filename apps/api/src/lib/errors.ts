/** Typed application error carrying an HTTP status and machine-readable code. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  badRequest: (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details),
  unauthorized: (message = "Invalid or missing authentication") => new AppError(401, "UNAUTHORIZED", message),
  forbidden: (message = "You do not have access to this resource") => new AppError(403, "FORBIDDEN", message),
  notFound: (message = "Resource not found") => new AppError(404, "NOT_FOUND", message),
  conflict: (message: string) => new AppError(409, "CONFLICT", message),
  serviceUnavailable: (message: string) => new AppError(503, "SERVICE_UNAVAILABLE", message),
};
