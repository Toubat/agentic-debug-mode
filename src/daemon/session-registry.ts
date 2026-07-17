import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import type { Session } from "../domain/session";
import { readJsonFile, writeJsonAtomic } from "../platform/atomic-file";
import { ensurePrivateFile } from "../platform/permissions";
import type { Persistence } from "./persistence";

export class SessionRegistry {
  constructor(private readonly persistence: Persistence) {}

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

  async list(): Promise<Session[]> {
    const entries = await readdir(this.persistence.sessionsDirectory, {
      withFileTypes: true,
    });
    const sessions = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(entry.name)),
    );
    return sessions
      .filter((session): session is Session => session !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async remove(sessionId: string): Promise<boolean> {
    if (!(await this.get(sessionId))) {
      return false;
    }
    await rm(this.persistence.sessionDirectory(sessionId), { force: true, recursive: true });
    return true;
  }
}
