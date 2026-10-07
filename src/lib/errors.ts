export type ErrorKind =
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "not_configured"
  | "timeout"
  | "provider_auth"
  | "rate_limit"
  | "provider_api"
  | "invalid_response"
  | "empty_response"
  | "network"
  | "internal";

const STATUS: Record<ErrorKind, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  not_configured: 503,
  timeout: 504,
  provider_auth: 502,
  rate_limit: 429,
  provider_api: 502,
  invalid_response: 502,
  empty_response: 502,
  network: 502,
  internal: 500,
};

/** An error whose message is safe to show to end users. */
export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly status: number;
  constructor(kind: ErrorKind, userMessage: string, options?: { cause?: unknown }) {
    super(userMessage, options);
    this.kind = kind;
    this.status = STATUS[kind];
    this.name = "AppError";
  }
}

/** Convert anything thrown into a safe message, logging the real cause server-side. */
export function toUserMessage(err: unknown): { message: string; status: number; kind: ErrorKind } {
  if (err instanceof AppError) return { message: err.message, status: err.status, kind: err.kind };
  console.error("[unhandled]", err);
  return { message: "Something went wrong. Please try again.", status: 500, kind: "internal" };
}
