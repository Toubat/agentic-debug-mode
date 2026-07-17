export type DiagnosticReason = "INVALID_JSON" | "INVALID_SCHEMA" | "SECRET_REDACTED";

export interface RecoverableEventFields {
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
