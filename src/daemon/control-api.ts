import type { DiagnosticStore } from "./diagnostic-store";
import type { EventStore } from "./event-store";
import type { SessionRegistry } from "./session-registry";

export class ControlApi {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly events: EventStore,
    private readonly diagnostics: DiagnosticStore,
  ) {}

  async handle(request: Request, pathname: string, origin: string): Promise<Response | undefined> {
    const liveMatch = /^\/v1\/events\/([a-zA-Z0-9_-]+)$/.exec(pathname);
    if (request.method === "GET" && liveMatch?.[1]) {
      const session = await this.sessions.get(liveMatch[1]);
      if (!session) {
        return Response.json({ code: "SESSION_NOT_FOUND" }, { status: 404 });
      }
      let cancelled = false;
      let lastSequence = 0;
      const eventStore = this.events;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            while (!cancelled && !request.signal.aborted) {
              const events = await eventStore.read(session.id);
              for (const event of events) {
                if (event.sequence <= lastSequence) {
                  continue;
                }
                lastSequence = event.sequence;
                controller.enqueue(
                  new TextEncoder().encode(
                    `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
                  ),
                );
              }
              await Bun.sleep(50);
            }
            if (!cancelled) {
              controller.close();
            }
          } catch (error) {
            if (!cancelled) {
              controller.error(error);
            }
          }
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, {
        headers: {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        },
      });
    }

    if (request.method === "GET" && pathname === "/v1/control/sessions") {
      const all = new URL(request.url).searchParams.get("all") === "true";
      return Response.json({ sessions: await this.sessions.list({ all }) });
    }

    const probeMatch = /^\/v1\/control\/sessions\/([a-zA-Z0-9_-]+)\/probe$/.exec(pathname);
    if (request.method === "GET" && probeMatch?.[1]) {
      const session = await this.sessions.get(probeMatch[1]);
      if (!session) {
        return Response.json({ code: "SESSION_NOT_FOUND" }, { status: 404 });
      }
      return Response.json({
        ingestPath: this.sessions.incomingPath(session.id),
        ingestUrl: `${origin}/v1/ingest/${session.id}`,
        sessionId: session.id,
      });
    }

    const evidenceMatch = /^\/v1\/control\/sessions\/([a-zA-Z0-9_-]+)\/(logs|status)$/.exec(
      pathname,
    );
    if (request.method === "GET" && evidenceMatch?.[1] && evidenceMatch[2]) {
      const session = await this.sessions.get(evidenceMatch[1]);
      if (!session) {
        return Response.json({ code: "SESSION_NOT_FOUND" }, { status: 404 });
      }
      const diagnostics = await this.diagnostics.read(session.id);
      if (evidenceMatch[2] === "status") {
        const events = await this.events.read(session.id);
        return Response.json({
          diagnostics,
          eventCount: events.length,
          session,
          watermark: events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0),
        });
      }
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const watermarkValue = url.searchParams.get("watermark");
      const watermark = watermarkValue === null ? undefined : Number(watermarkValue);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        (watermark !== undefined && (!Number.isSafeInteger(watermark) || watermark < 0))
      ) {
        return Response.json({ code: "INVALID_ARGUMENTS" }, { status: 400 });
      }
      const page = await this.events.readPage(session.id, {
        hypothesisIds: url.searchParams.getAll("hypothesis"),
        limit,
        offset,
        watermark,
      });
      return Response.json({ diagnostics, ...page });
    }

    const deleteMatch = /^\/v1\/control\/sessions\/([a-zA-Z0-9_-]+)$/.exec(pathname);
    if (request.method === "DELETE" && deleteMatch?.[1]) {
      const removed = await this.sessions.remove(deleteMatch[1]);
      if (!removed) {
        return Response.json({ code: "SESSION_NOT_FOUND" }, { status: 404 });
      }
      return Response.json({ removed: true, sessionId: deleteMatch[1] });
    }

    if (request.method !== "POST") {
      return undefined;
    }
    if (pathname === "/v1/control/sessions") {
      const session = await this.sessions.create();
      return Response.json(
        {
          appendPath: this.sessions.incomingPath(session.id),
          ingestUrl: `${origin}/v1/ingest/${session.id}`,
          sessionId: session.id,
        },
        { status: 201 },
      );
    }

    const resetMatch = /^\/v1\/control\/sessions\/([a-zA-Z0-9_-]+)\/reset$/.exec(pathname);
    if (resetMatch?.[1]) {
      if (!(await this.sessions.get(resetMatch[1]))) {
        return Response.json({ code: "SESSION_NOT_FOUND" }, { status: 404 });
      }
      const session = await this.sessions.reset(resetMatch[1]);
      return Response.json({
        appendPath: this.sessions.incomingPath(session.id),
        ingestUrl: `${origin}/v1/ingest/${session.id}`,
        sessionId: session.id,
      });
    }

    return undefined;
  }
}
