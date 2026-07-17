export type DiagnosticReason =
  | "INVALID_JSON"
  | "INVALID_SCHEMA"
  | "SECRET_REDACTED"
  | "UNDECLARED_HYPOTHESIS_ID";

export interface RecoverableEventFields {
  runId?: string;
  hypothesisId?: string;
  location?: string;
}

export interface EvidenceDiagnostic {
  diagnosticId: string;
  reason: DiagnosticReason;
  message: string;
  observedAt: number;
  recoverable: RecoverableEventFields;
  redactedPreview: string;
  suggestedAction: string;
  eventId?: string;
}
