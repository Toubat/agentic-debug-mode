import { createHash, randomUUID } from "node:crypto";
import type { EvidenceDiagnostic } from "./diagnostic";

export const MAX_INGESTION_RECORD_BYTES = 64 * 1024;
export const MAX_HYPOTHESIS_ID_LENGTH = 256;
export const MAX_MALFORMED_PREVIEW_BYTES = 256;

export interface MalformedIngestionDiagnosticInput {
  actualByteLength: number;
  diagnosticId?: string;
  observedAt: number;
  previewByteLength: number;
}

export function ingestionRecordByteLength(record: string): number {
  return new TextEncoder().encode(record).byteLength;
}

export function malformedIngestionDiagnostic(
  input: MalformedIngestionDiagnosticInput,
): EvidenceDiagnostic {
  const overLimit = input.actualByteLength > MAX_INGESTION_RECORD_BYTES;
  return {
    diagnosticId: input.diagnosticId ?? `diag_${randomUUID()}`,
    message: overLimit
      ? `An ingestion record exceeded the ${MAX_INGESTION_RECORD_BYTES}-byte limit (actual: ${input.actualByteLength} bytes).`
      : "An ingestion record could not be parsed.",
    observedAt: input.observedAt,
    reason: "INVALID_JSON",
    recoverable: {},
    redactedPreview: `[redacted malformed ingestion preview: ${input.previewByteLength} bytes]`,
    suggestedAction:
      "Inspect the generated probe serializer, correct it, reset the session, and reproduce.",
  };
}

export function directSourceContentHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function directSourceId(
  prefix: "diag" | "evt",
  sessionId: string,
  offset: number,
  contentHash: string,
): string {
  const digest = createHash("sha256")
    .update(prefix)
    .update("\0")
    .update(sessionId)
    .update("\0")
    .update(String(offset))
    .update("\0")
    .update(contentHash)
    .digest("hex");
  return `${prefix}_${digest}`;
}

export function directAppendEventId(
  sessionId: string,
  offset: number,
  contentHash: string,
): string {
  return directSourceId("evt", sessionId, offset, contentHash);
}

export function directAppendDiagnosticId(
  sessionId: string,
  offset: number,
  contentHash: string,
): string {
  return directSourceId("diag", sessionId, offset, contentHash);
}
