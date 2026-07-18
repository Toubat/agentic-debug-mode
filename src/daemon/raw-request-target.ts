import { isCanonicalSessionId } from "../domain/session-id";

export type RawIngestionTarget =
  | { kind: "ingestion"; pathname: string }
  | { kind: "invalid-ingestion" }
  | { kind: "other" };

function rawPath(target: string): string | undefined {
  if (target.startsWith("/")) {
    return target;
  }
  const absolute = /^https?:\/\/[^/?#]+(\/.*)?$/i.exec(target);
  return absolute ? (absolute[1] ?? "/") : undefined;
}

function resemblesIngestion(path: string): boolean {
  const lower = path.toLowerCase();
  let decoded: string;
  try {
    decoded = decodeURIComponent(path).toLowerCase();
  } catch {
    return /%[0-9a-f]{0,2}/i.test(path);
  }
  return (
    lower.startsWith("/ingest") ||
    decoded.startsWith("/ingest") ||
    ((/(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded) || /%2e/i.test(lower)) &&
      decoded.includes("/ingest/"))
  );
}

export function parseRawIngestionTarget(target: string): RawIngestionTarget {
  const path = rawPath(target);
  if (path === undefined || !resemblesIngestion(path)) {
    return { kind: "other" };
  }
  if (
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    /%(?:2e|2f|5c|25)/i.test(path)
  ) {
    return { kind: "invalid-ingestion" };
  }
  const prefix = "/ingest/";
  if (!path.startsWith(prefix)) {
    return { kind: "invalid-ingestion" };
  }
  const sessionId = path.slice(prefix.length);
  if (!isCanonicalSessionId(sessionId)) {
    return { kind: "invalid-ingestion" };
  }
  return { kind: "ingestion", pathname: path };
}
