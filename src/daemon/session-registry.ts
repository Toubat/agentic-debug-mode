import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { Session } from "../domain/session";
import { readJsonFile, writeJsonAtomic } from "../platform/atomic-file";
import { ensurePrivateFile } from "../platform/permissions";
import type { Persistence } from "./persistence";

export interface CreateSessionInput {
  activeRunId: string;
  workspace: string;
  createdAt?: number;
}

export class SessionRegistry {
  constructor(private readonly persistence: Persistence) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const session: Session = Object.freeze({
      activeRunId: input.activeRunId,
      createdAt: input.createdAt ?? Date.now(),
      id: randomUUID(),
      status: "active",
      workspace: input.workspace,
    });
    await this.persistence.initializeSessionDirectory(session.id);
    await Promise.all([
      writeJsonAtomic(this.persistence.sessionFile(session.id, "session.json"), session),
      writeJsonAtomic(this.persistence.sessionFile(session.id, "runs.json"), []),
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

  async findByWorkspace(workspace: string): Promise<Session[]> {
    return (await this.list()).filter((session) => session.workspace === workspace);
  }
}
