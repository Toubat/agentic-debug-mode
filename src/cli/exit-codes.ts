export const EXIT_CODE = {
  daemonUnavailable: 4,
  evidenceMalformed: 6,
  failure: 1,
  invalidArguments: 2,
  sessionNotFound: 5,
  success: 0,
  versionIncompatible: 3,
} as const;

const ERROR_EXIT_CODES: Record<string, number> = {
  COLLECTION_REQUIRED: EXIT_CODE.invalidArguments,
  DAEMON_UNAVAILABLE: EXIT_CODE.daemonUnavailable,
  EVIDENCE_MALFORMED: EXIT_CODE.evidenceMalformed,
  INVALID_ARGUMENTS: EXIT_CODE.invalidArguments,
  SESSION_AMBIGUOUS: EXIT_CODE.sessionNotFound,
  SESSION_NOT_FOUND: EXIT_CODE.sessionNotFound,
  UNSUPPORTED_LANGUAGE: EXIT_CODE.invalidArguments,
  VERSION_INCOMPATIBLE: EXIT_CODE.versionIncompatible,
};

export function exitCodeForError(errorCode: string): number {
  return ERROR_EXIT_CODES[errorCode] ?? EXIT_CODE.failure;
}
