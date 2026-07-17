const CANONICAL_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class InvalidSessionIdError extends Error {
  readonly code = "INVALID_ARGUMENTS";

  constructor() {
    super("Session ID must be a canonical UUID.");
    this.name = "InvalidSessionIdError";
  }
}

export function sessionPathSegment(sessionId: string): string {
  if (!CANONICAL_SESSION_ID.test(sessionId)) {
    throw new InvalidSessionIdError();
  }
  return encodeURIComponent(sessionId);
}
