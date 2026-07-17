import { createHmac, timingSafeEqual } from "node:crypto";

export interface SnapshotCursorPayload {
  issuedAt: number;
  sessionId: string;
  watermark: number;
}

export interface QueryCursorPayload extends SnapshotCursorPayload {
  hypotheses: string[];
  limit: number;
  offset: number;
  program: string;
  slurp: boolean;
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

export function createQueryCursor(secret: string, payload: QueryCursorPayload): string {
  const encoded = Buffer.from(JSON.stringify({ ...payload, version: 1 })).toString("base64url");
  return `${encoded}.${signature(secret, encoded)}`;
}

export function verifyQueryCursor(
  secret: string,
  cursor: string,
  scope: Pick<QueryCursorPayload, "sessionId">,
): QueryCursorPayload {
  const parts = cursor.split(".");
  const encoded = parts[0];
  const providedSignature = parts[1];
  if (!encoded || !providedSignature || parts.length !== 2) {
    throw new Error("Invalid query cursor");
  }
  const expectedSignature = signature(secret, encoded);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error("Invalid query cursor");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid query cursor");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid query cursor");
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.sessionId !== "string" ||
    typeof payload.watermark !== "number" ||
    !Number.isSafeInteger(payload.watermark) ||
    payload.watermark < 0 ||
    typeof payload.limit !== "number" ||
    !Number.isSafeInteger(payload.limit) ||
    payload.limit < 1 ||
    typeof payload.offset !== "number" ||
    !Number.isSafeInteger(payload.offset) ||
    payload.offset < 0 ||
    typeof payload.program !== "string" ||
    payload.program.length < 1 ||
    payload.program.length > 4_096 ||
    typeof payload.slurp !== "boolean" ||
    !Array.isArray(payload.hypotheses) ||
    !payload.hypotheses.every((item) => typeof item === "string")
  ) {
    throw new Error("Invalid query cursor");
  }
  if (payload.sessionId !== scope.sessionId) {
    throw new Error("Query cursor scope does not match");
  }
  return {
    hypotheses: payload.hypotheses as string[],
    issuedAt: payload.issuedAt,
    limit: payload.limit,
    offset: payload.offset,
    program: payload.program,
    sessionId: payload.sessionId,
    slurp: payload.slurp,
    watermark: payload.watermark,
  };
}
