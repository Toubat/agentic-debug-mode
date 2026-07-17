import { createHmac, timingSafeEqual } from "node:crypto";

export interface SnapshotCursorPayload {
  issuedAt: number;
  sessionId: string;
  watermark: number;
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSnapshotCursor(secret: string, payload: SnapshotCursorPayload): string {
  const encoded = Buffer.from(JSON.stringify({ ...payload, version: 1 })).toString("base64url");
  return `${encoded}.${signature(secret, encoded)}`;
}

export function verifySnapshotCursor(
  secret: string,
  cursor: string,
  scope: Pick<SnapshotCursorPayload, "sessionId">,
): SnapshotCursorPayload {
  const parts = cursor.split(".");
  const encoded = parts[0];
  const providedSignature = parts[1];
  if (!encoded || !providedSignature || parts.length !== 2) {
    throw new Error("Invalid snapshot cursor");
  }
  const expectedSignature = signature(secret, encoded);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error("Invalid snapshot cursor");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid snapshot cursor");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid snapshot cursor");
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.sessionId !== "string" ||
    typeof payload.watermark !== "number" ||
    !Number.isSafeInteger(payload.watermark) ||
    payload.watermark < 0
  ) {
    throw new Error("Invalid snapshot cursor");
  }
  if (payload.sessionId !== scope.sessionId) {
    throw new Error("Snapshot cursor scope does not match");
  }
  return {
    issuedAt: payload.issuedAt,
    sessionId: payload.sessionId,
    watermark: payload.watermark,
  };
}
