import type { DiagnosticStore } from "./diagnostic-store";
import type { EventStore } from "./event-store";
import type { RunRegistry } from "./run-registry";
import type { SessionRegistry } from "./session-registry";

interface CreateSessionBody {
  hypothesisIds: string[];
  runId: string;
  workspace: string;
}

interface RunBody {
  hypothesisIds: string[];
  runId: string;
}

function isRunBody(value: unknown): value is RunBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.runId === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(body.runId) &&
    Array.isArray(body.hypothesisIds) &&
    body.hypothesisIds.length > 0 &&
    body.hypothesisIds.every(
      (hypothesis) => typeof hypothesis === "string" && /^[a-zA-Z0-9_-]+$/.test(hypothesis),
    )
  );
}

function isCreateSessionBody(value: unknown): value is CreateSessionBody {
  return (
    isRunBody(value) &&
    "workspace" in value &&
    typeof value.workspace === "string" &&
    value.workspace.length > 0
  );
}

async function readBody(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    return Response.json(
      { code: "INVALID_ARGUMENTS", message: "Request body must be JSON." },
      { status: 400 },
    );
  }
}

export class ControlApi {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly runs: RunRegistry,
    private readonly events: EventStore,
    private readonly diagnostics: DiagnosticStore,
  ) {}

  async handle(request: Request, pathname: string, origin: string): Promise<Response | undefined> {
    if (request.method !== "POST") {
      return undefined;
    }
    if (pathname === "/v1/control/sessions") {
      const body = await readBody(request);
      if (body instanceof Response) {
        return body;
      }
      if (!isCreateSessionBody(body)) {
        return Response.json(
          {
            code: "INVALID_ARGUMENTS",
            message: "workspace, runId, and at least one valid hypothesis ID are required.",
          },
          { status: 400 },
        );
      }
      const session = await this.sessions.create({
        activeRunId: body.runId,
        workspace: body.workspace,
      });
      const run = await this.runs.declare(session.id, {
        createdAt: Date.now(),
        hypothesisIds: body.hypothesisIds,
        id: body.runId,
      });
      return Response.json(
        {
          ingestUrl: `${origin}/v1/ingest/${session.ingestCapability}`,
          runId: run.id,
          sessionId: session.id,
        },
        { status: 201 },
      );
    }

    const runMatch = /^\/v1\/control\/sessions\/([a-zA-Z0-9_-]+)\/runs$/.exec(pathname);
    if (runMatch?.[1]) {
      const body = await readBody(request);
      if (body instanceof Response) {
        return body;
      }
      if (!isRunBody(body) || !(await this.sessions.get(runMatch[1]))) {
        return Response.json(
          { code: "INVALID_ARGUMENTS", message: "Session or run declaration is invalid." },
          { status: 400 },
        );
      }
      const run = await this.runs.declare(runMatch[1], {
        createdAt: Date.now(),
        hypothesisIds: body.hypothesisIds,
        id: body.runId,
      });
      await this.sessions.setActiveRun(runMatch[1], run.id);
      return Response.json({ runId: run.id, sessionId: runMatch[1] }, { status: 201 });
    }

    const clearMatch = /^\/v1\/control\/sessions\/([a-zA-Z0-9_-]+)\/clear$/.exec(pathname);
    if (clearMatch?.[1]) {
      const body = await readBody(request);
      if (body instanceof Response) {
        return body;
      }
      const runId =
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        typeof (body as Record<string, unknown>).runId === "string"
          ? ((body as Record<string, unknown>).runId as string)
          : undefined;
      if (!runId || !(await this.runs.get(clearMatch[1], runId))) {
        return Response.json(
          { code: "INVALID_ARGUMENTS", message: "A known runId is required." },
          { status: 400 },
        );
      }
      await Promise.all([
        this.events.clearRun(clearMatch[1], runId),
        this.diagnostics.clearRun(clearMatch[1], runId),
      ]);
      return Response.json({ cleared: true, runId, sessionId: clearMatch[1] });
    }

    return undefined;
  }
}
