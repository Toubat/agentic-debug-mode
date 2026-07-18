import { createHmac, timingSafeEqual } from "node:crypto";

export interface SnapshotCursorPayload {
  issuedAt: number;
  sessionId: string;
  watermark: number;
}

export type QueryContinuation =
  | {
      byteOffset: number;
      kind: "stream";
      outputOrdinal: number;
    }
  | {
      byteOffset: number;
      kind: "spool";
      spoolId: string;
    };

export interface QueryCursorPayload extends SnapshotCursorPayload {
  continuation: QueryContinuation;
  evidenceEpoch: string;
  hypotheses: string[];
  json: boolean;
  limit: number;
  program: string;
  slurp: boolean;
  timeoutMs: number;
}

export class QueryCursorStaleError extends Error {
  readonly code = "CURSOR_STALE";

  constructor() {
    super("Query cursor is stale because the session evidence was reset.");
    this.name = "QueryCursorStaleError";
  }
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
  scope: Pick<QueryCursorPayload, "evidenceEpoch" | "sessionId">,
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
    typeof payload.evidenceEpoch !== "string" ||
    typeof payload.limit !== "number" ||
    !Number.isSafeInteger(payload.limit) ||
    payload.limit < 1 ||
    typeof payload.timeoutMs !== "number" ||
    !Number.isSafeInteger(payload.timeoutMs) ||
    payload.timeoutMs < 1 ||
    typeof payload.program !== "string" ||
    payload.program.length < 1 ||
    payload.program.length > 4_096 ||
    typeof payload.slurp !== "boolean" ||
    typeof payload.json !== "boolean" ||
    !Array.isArray(payload.hypotheses) ||
    !payload.hypotheses.every((item) => typeof item === "string") ||
    !isQueryContinuation(payload.continuation) ||
    (payload.slurp && payload.continuation.kind !== "spool") ||
    (!payload.slurp && payload.continuation.kind !== "stream")
  ) {
    throw new Error("Invalid query cursor");
  }
  if (payload.sessionId !== scope.sessionId) {
    throw new Error("Query cursor scope does not match");
  }
  if (payload.evidenceEpoch !== scope.evidenceEpoch) {
    throw new QueryCursorStaleError();
  }
  return {
    continuation: payload.continuation,
    evidenceEpoch: payload.evidenceEpoch,
    hypotheses: payload.hypotheses as string[],
    issuedAt: payload.issuedAt,
    json: payload.json,
    limit: payload.limit,
    program: payload.program,
    sessionId: payload.sessionId,
    slurp: payload.slurp,
    timeoutMs: payload.timeoutMs,
    watermark: payload.watermark,
  };
}

function isQueryContinuation(value: unknown): value is QueryContinuation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const continuation = value as Record<string, unknown>;
  if (
    typeof continuation.byteOffset !== "number" ||
    !Number.isSafeInteger(continuation.byteOffset) ||
    continuation.byteOffset < 0
  ) {
    return false;
  }
  if (continuation.kind === "stream") {
    return (
      typeof continuation.outputOrdinal === "number" &&
      Number.isSafeInteger(continuation.outputOrdinal) &&
      continuation.outputOrdinal >= 0
    );
  }
  return (
    continuation.kind === "spool" &&
    typeof continuation.spoolId === "string" &&
    /^[0-9a-f-]{36}$/.test(continuation.spoolId)
  );
}
