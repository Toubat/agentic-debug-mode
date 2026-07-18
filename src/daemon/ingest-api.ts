import { validateAndNormalizeEvent } from "../domain/event-validation";
import {
  ingestionRecordByteLength,
  MAX_INGESTION_RECORD_BYTES,
  malformedIngestionDiagnostic,
} from "../domain/ingestion";
import { isCanonicalSessionId } from "../domain/session-id";
import type { DiagnosticStore } from "./diagnostic-store";
import type { EventStore } from "./event-store";
import type { EventSequence } from "./sequence";
import type { SessionRegistry } from "./session-registry";

export type IngestionResult = "accepted" | "invalid" | "not-found" | "too-large";

export interface IngestionOptions {
  eventId?: string;
}

export interface IngestApiHooks {
  afterBodyRead?(): Promise<void>;
}

function corsHeaders(origin: string | null): HeadersInit {
  if (!origin) {
    return {};
  }
  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) {
    return true;
  }
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

export class IngestionService {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly events: EventStore,
    private readonly diagnostics: DiagnosticStore,
    private readonly sequence: EventSequence,
  ) {}

  async hasSession(sessionId: string): Promise<boolean> {
    return this.events.runSessionOperation(sessionId, async () =>
      Boolean(await this.sessions.get(sessionId)),
    );
  }

  async ingestRecord(
    sessionId: string,
    record: string,
    options: IngestionOptions = {},
  ): Promise<IngestionResult> {
    return this.events.runSessionOperation(sessionId, async () => {
      if (!(await this.sessions.get(sessionId))) {
        return "not-found";
      }
      if (ingestionRecordByteLength(record) > MAX_INGESTION_RECORD_BYTES) {
        await this.diagnostics.append(sessionId, [
          malformedIngestionDiagnostic(record, Date.now()),
        ]);
        return "too-large";
      }
      let value: unknown;
      try {
        value = JSON.parse(record);
      } catch {
        await this.diagnostics.append(sessionId, [
          malformedIngestionDiagnostic(record, Date.now()),
        ]);
        return "invalid";
      }
      return this.ingest(sessionId, value, options);
    });
  }

  async ingest(
    sessionId: string,
    value: unknown,
    options: IngestionOptions = {},
  ): Promise<"accepted" | "invalid" | "not-found"> {
    return this.events.runSessionOperation(sessionId, async () => {
      const session = await this.sessions.get(sessionId);
      if (!session) {
        return "not-found";
      }
      const result = validateAndNormalizeEvent(value, {
        eventId: options.eventId,
        receivedAt: Date.now(),
        sequence: 0,
      });
      if (!result.event) {
        await this.diagnostics.append(session.id, result.diagnostics);
        return "invalid";
      }
      if (await this.events.hasId(session.id, result.event.id)) {
        return "accepted";
      }
      result.event.sequence = await this.sequence.next(session.id);
      if (!(await this.events.append(session.id, result.event))) {
        throw new Error("Event ID became duplicated inside a serialized session operation");
      }
      await this.diagnostics.append(session.id, result.diagnostics);
      return "accepted";
    });
  }
}

export class IngestApi {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly hooks: IngestApiHooks = {},
  ) {}

  async handle(request: Request, pathname: string): Promise<Response | undefined> {
    if (!pathname.startsWith("/ingest/")) {
      return undefined;
    }
    const sessionId = pathname.slice("/ingest/".length);
    if (!isCanonicalSessionId(sessionId)) {
      return Response.json({ code: "INVALID_ARGUMENTS" }, { status: 400 });
    }
    const origin = request.headers.get("origin");
    if (!isAllowedOrigin(origin)) {
      return Response.json({ error: "origin-not-allowed" }, { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin), status: 204 });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method-not-allowed" }, { status: 405 });
    }
    if (!(await this.ingestion.hasSession(sessionId))) {
      return this.sessionNotFound(origin);
    }

    const text = await request.text();
    await this.hooks.afterBodyRead?.();
    const contentType = request.headers.get("content-type") ?? "";
    const records = contentType.includes("application/x-ndjson")
      ? text.split("\n").filter(Boolean)
      : [text];
    let accepted = 0;
    let invalid = 0;
    for (const record of records) {
      const result = await this.ingestion.ingestRecord(sessionId, record);
      switch (result) {
        case "accepted":
          accepted += 1;
          break;
        case "invalid":
          invalid += 1;
          break;
        case "not-found":
          return this.sessionNotFound(origin);
        case "too-large":
          return Response.json(
            { error: "payload-too-large" },
            { headers: corsHeaders(origin), status: 413 },
          );
        default: {
          const exhaustive: never = result;
          throw new Error(`Unhandled ingestion result: ${exhaustive}`);
        }
      }
    }
    return Response.json({ accepted, invalid }, { headers: corsHeaders(origin), status: 202 });
  }

  private sessionNotFound(origin: string | null): Response {
    return Response.json(
      { code: "SESSION_NOT_FOUND" },
      { headers: corsHeaders(origin), status: 404 },
    );
  }
}
