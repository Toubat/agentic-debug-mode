import { randomUUID } from "node:crypto";
import type { EvidenceDiagnostic } from "./diagnostic";
import type { JsonValue, NormalizedEvent } from "./event";
import { MAX_HYPOTHESIS_ID_LENGTH } from "./ingestion";
import { redactSecrets } from "./redaction";

export interface EventValidationContext {
  eventId?: string;
  receivedAt: number;
  sequence: number;
}

export interface EventValidationResult {
  diagnostics: EvidenceDiagnostic[];
  event?: NormalizedEvent;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) {
    return false;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value === "string") {
    return value.length <= 4_096;
  }
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((item) => isJsonValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return (
      entries.length <= 100 &&
      entries.every(([key, item]) => key.length <= 256 && isJsonValue(item, depth + 1))
    );
  }
  return false;
}

function isBoundedJsonValue(value: unknown): value is JsonValue {
  return (
    isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32 * 1024
  );
}

function recoverable(raw: Record<string, unknown>) {
  return {
    hypothesisId: typeof raw.hypothesisId === "string" ? raw.hypothesisId : undefined,
    location: typeof raw.location === "string" ? raw.location : undefined,
  };
}

function diagnostic(
  reason: EvidenceDiagnostic["reason"],
  message: string,
  raw: Record<string, unknown>,
  observedAt: number,
): EvidenceDiagnostic {
  return {
    diagnosticId: `diag_${randomUUID()}`,
    message,
    observedAt,
    reason,
    recoverable: recoverable(raw),
    redactedPreview: "[redacted invalid event]",
    suggestedAction:
      "Inspect the generated probe, correct its structured fields, reset the session, and reproduce.",
  };
}

export function validateAndNormalizeEvent(
  value: unknown,
  context: EventValidationContext,
): EventValidationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      diagnostics: [
        diagnostic("INVALID_SCHEMA", "An event must be a JSON object.", {}, context.receivedAt),
      ],
    };
  }
  const raw = value as Record<string, unknown>;
  const valid =
    typeof raw.hypothesisId === "string" &&
    raw.hypothesisId.length > 0 &&
    raw.hypothesisId.length <= MAX_HYPOTHESIS_ID_LENGTH &&
    typeof raw.timestamp === "number" &&
    Number.isFinite(raw.timestamp) &&
    typeof raw.location === "string" &&
    raw.location.length > 0 &&
    raw.location.length <= 1_024 &&
    typeof raw.message === "string" &&
    raw.message.length > 0 &&
    raw.message.length <= 1_024 &&
    isBoundedJsonValue(raw.data);
  if (!valid) {
    return {
      diagnostics: [
        diagnostic(
          "INVALID_SCHEMA",
          "The event does not match the required bounded schema or route scope.",
          raw,
          context.receivedAt,
        ),
      ],
    };
  }

  const id = context.eventId ?? `evt_${randomUUID()}`;
  const redaction = redactSecrets(raw.data as JsonValue);
  const event: NormalizedEvent = {
    data: redaction.value,
    hypothesisId: raw.hypothesisId as string,
    id,
    location: raw.location as string,
    message: raw.message as string,
    receivedAt: context.receivedAt,
    sequence: context.sequence,
    timestamp: raw.timestamp as number,
  };
  const diagnostics: EvidenceDiagnostic[] = [];
  if (redaction.redactedPaths.length > 0) {
    diagnostics.push({
      ...diagnostic(
        "SECRET_REDACTED",
        `Sensitive fields were redacted: ${redaction.redactedPaths.join(", ")}.`,
        raw,
        context.receivedAt,
      ),
      eventId: event.id,
    });
  }
  return { diagnostics, event };
}
