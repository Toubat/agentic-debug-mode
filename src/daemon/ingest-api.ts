import { randomUUID } from "node:crypto";
import type { EvidenceDiagnostic } from "../domain/diagnostic";
import { validateAndNormalizeEvent } from "../domain/event-validation";
import type { DiagnosticStore } from "./diagnostic-store";
import type { EventStore } from "./event-store";
import type { RunRegistry } from "./run-registry";
import type { EventSequence } from "./sequence";
import type { SessionRegistry } from "./session-registry";

const MAX_BODY_BYTES = 64 * 1024;

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
    private readonly runs: RunRegistry,
    private readonly events: EventStore,
    private readonly diagnostics: DiagnosticStore,
    private readonly sequence: EventSequence,
  ) {}

  private async sessionForCapability(capability: string) {
    return (await this.sessions.list()).find(
      (session) => session.status === "active" && session.ingestCapability === capability,
    );
  }

  async recordInvalidJson(capability: string, message: string): Promise<boolean> {
    const session = await this.sessionForCapability(capability);
    if (!session) {
      return false;
    }
    const diagnostic: EvidenceDiagnostic = {
      diagnosticId: `diag_${randomUUID()}`,
      message,
      observedAt: Date.now(),
      reason: "INVALID_JSON",
      recoverable: { runId: session.activeRunId },
      redactedPreview: "[redacted invalid JSON]",
      suggestedAction:
        "Inspect the generated probe serializer, correct it, clear the run, and reproduce.",
    };
    await this.diagnostics.append(session.id, [diagnostic]);
    return true;
  }

  async ingest(capability: string, value: unknown): Promise<"accepted" | "invalid" | "not-found"> {
    const session = await this.sessionForCapability(capability);
    if (!session) {
      return "not-found";
    }
    const run = await this.runs.get(session.id, session.activeRunId);
    if (!run) {
      throw new Error(`Active run ${session.activeRunId} is missing`);
    }
    const result = validateAndNormalizeEvent(value, {
      receivedAt: Date.now(),
      run,
      sequence: 0,
      session,
    });
    if (!result.event) {
      await this.diagnostics.append(session.id, result.diagnostics);
      return "invalid";
    }
    result.event.sequence = await this.sequence.next(session.id);
    await this.events.append(result.event);
    await this.diagnostics.append(session.id, result.diagnostics);
    return "accepted";
  }
}

export class IngestApi {
  constructor(private readonly ingestion: IngestionService) {}

  async handle(request: Request, pathname: string): Promise<Response | undefined> {
    const match = /^\/v1\/ingest\/([a-zA-Z0-9_-]+)$/.exec(pathname);
    if (!match) {
      return undefined;
    }
    const capability = match[1];
    if (!capability) {
      return Response.json({ error: "not-found" }, { status: 404 });
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

    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return Response.json(
        { error: "payload-too-large" },
        { headers: corsHeaders(origin), status: 413 },
      );
    }
    const contentType = request.headers.get("content-type") ?? "";
    const values: unknown[] = [];
    if (contentType.includes("application/x-ndjson")) {
      for (const line of text.split("\n").filter(Boolean)) {
        try {
          values.push(JSON.parse(line));
        } catch {
          await this.ingestion.recordInvalidJson(
            capability,
            "An NDJSON record could not be parsed.",
          );
        }
      }
    } else {
      try {
        values.push(JSON.parse(text));
      } catch {
        const found = await this.ingestion.recordInvalidJson(
          capability,
          "The JSON request body could not be parsed.",
        );
        return Response.json(
          { accepted: found, malformed: 1 },
          {
            headers: corsHeaders(origin),
            status: found ? 202 : 404,
          },
        );
      }
    }

    let accepted = 0;
    let invalid = 0;
    for (const value of values) {
      const result = await this.ingestion.ingest(capability, value);
      if (result === "not-found") {
        return Response.json({ error: "not-found" }, { headers: corsHeaders(origin), status: 404 });
      }
      if (result === "accepted") {
        accepted += 1;
      } else {
        invalid += 1;
      }
    }
    return Response.json({ accepted, invalid }, { headers: corsHeaders(origin), status: 202 });
  }
}
