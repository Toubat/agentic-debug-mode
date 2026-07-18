import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import type { Session } from "../domain/session";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "../platform/atomic-file";
import { ensurePrivateFile } from "../platform/permissions";
import { DiagnosticStore } from "./diagnostic-store";
import { EventStore } from "./event-store";
import type { Persistence } from "./persistence";
import { EventSequence } from "./sequence";

export interface SessionSummary {
  id: string;
  createdAt: number;
  eventCount: number;
}

export interface ListSessionsOptions {
  all: boolean;
  now?: Date;
  limit?: number;
}

export class SessionRegistry {
  constructor(
    private readonly persistence: Persistence,
    private readonly events = new EventStore(persistence),
    private readonly diagnostics = new DiagnosticStore(persistence),
    private readonly sequence = new EventSequence(events),
  ) {}

  incomingPath(sessionId: string): string {
    return this.persistence.sessionFile(sessionId, "incoming.ndjson");
  }

  async create(createdAt = Date.now()): Promise<Session> {
    const session: Session = Object.freeze({
      createdAt,
      eventSchemaVersion: 1,
      evidenceEpoch: randomUUID(),
      id: randomUUID(),
    });
    await this.persistence.initializeSessionDirectory(session.id);
    await Promise.all([
      writeJsonAtomic(this.persistence.sessionFile(session.id, "session.json"), session),
      writeJsonAtomic(this.persistence.sessionFile(session.id, "incoming.cursor.json"), {
        offset: 0,
      }),
      ensurePrivateFile(this.persistence.sessionFile(session.id, "incoming.ndjson")),
      ensurePrivateFile(this.persistence.sessionFile(session.id, "events.ndjson")),
      ensurePrivateFile(this.persistence.sessionFile(session.id, "diagnostics.ndjson")),
    ]);
    return session;
  }

  async get(sessionId: string): Promise<Session | undefined> {
    try {
      return Object.freeze(
        await readJsonFile<Session>(this.persistence.sessionFile(sessionId, "session.json")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async list(options: ListSessionsOptions): Promise<SessionSummary[]> {
    const entries = await readdir(this.persistence.sessionsDirectory, {
      withFileTypes: true,
    });
    const sessions = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(entry.name)),
    );
    let filtered = sessions
      .filter((session): session is Session => session !== undefined)
      .sort((left, right) => right.createdAt - left.createdAt);
    if (!options.all) {
      const now = options.now ?? new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).valueOf();
      filtered = filtered.filter(
        (session) => session.createdAt >= start && session.createdAt < end,
      );
    }
    const limit = options.limit ?? (options.all ? undefined : 20);
    if (limit !== undefined) {
      filtered = filtered.slice(0, limit);
    }
    return Promise.all(
      filtered.map(async (session) => ({
        createdAt: session.createdAt,
        eventCount: (await this.events.summarize(session.id)).eventCount,
        id: session.id,
      })),
    );
  }

  async reset(sessionId: string): Promise<Session | undefined> {
    return this.persistence.runSessionOperation(sessionId, async () => {
      await this.persistence.rejectSessionSymbolicLinks(sessionId);
      const session = await this.get(sessionId);
      if (!session) {
        return undefined;
      }
      const reset = Object.freeze({
        ...session,
        evidenceEpoch: randomUUID(),
      });
      await Promise.all([
        this.events.clear(sessionId),
        this.diagnostics.clear(sessionId),
        this.persistence.clearQuerySpools(sessionId),
        writeTextAtomic(this.persistence.sessionFile(sessionId, "incoming.ndjson"), ""),
        writeJsonAtomic(this.persistence.sessionFile(sessionId, "incoming.cursor.json"), {
          offset: 0,
        }),
      ]);
      await this.sequence.reset(sessionId);
      await writeJsonAtomic(this.persistence.sessionFile(sessionId, "session.json"), reset);
      return reset;
    });
  }

  async remove(sessionId: string): Promise<boolean> {
    return this.persistence.runSessionOperation(sessionId, async () => {
      await this.persistence.rejectSessionSymbolicLinks(sessionId);
      if (!(await this.get(sessionId))) {
        return false;
      }
      await rm(this.persistence.sessionDirectory(sessionId), { force: true, recursive: true });
      await this.sequence.reset(sessionId);
      return true;
    });
  }
}
