import { isCanonicalSessionId } from "../domain/session-id";

export class InvalidSessionIdError extends Error {
  readonly code = "INVALID_ARGUMENTS";

  constructor() {
    super("Session ID must be a canonical UUID.");
    this.name = "InvalidSessionIdError";
  }
}

export function sessionPathSegment(sessionId: string): string {
  if (!isCanonicalSessionId(sessionId)) {
    throw new InvalidSessionIdError();
  }
  return encodeURIComponent(sessionId);
}
