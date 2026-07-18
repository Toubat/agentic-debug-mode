import { randomUUID } from "node:crypto";
import type { EvidenceDiagnostic } from "./diagnostic";

export const MAX_INGESTION_RECORD_BYTES = 64 * 1024;
export const MAX_HYPOTHESIS_ID_LENGTH = 256;

export function ingestionRecordByteLength(record: string): number {
  return new TextEncoder().encode(record).byteLength;
}

export function malformedIngestionDiagnostic(
  record: string,
  observedAt: number,
): EvidenceDiagnostic {
  return {
    diagnosticId: `diag_${randomUUID()}`,
    message: "An ingestion record could not be parsed.",
    observedAt,
    reason: "INVALID_JSON",
    recoverable: {},
    redactedPreview: `[redacted malformed ingestion: ${ingestionRecordByteLength(record)} bytes]`,
    suggestedAction:
      "Inspect the generated probe serializer, correct it, reset the session, and reproduce.",
  };
}
