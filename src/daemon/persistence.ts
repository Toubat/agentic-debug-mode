import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory } from "../platform/permissions";
import { initializeStateRoot } from "../platform/state-root";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_FILENAME = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;
const OWNED_SESSION_FILES = [
  "diagnostics.ndjson",
  "events.ndjson",
  "incoming.cursor.json",
  "incoming.ndjson",
  "session.json",
] as const;

export class Persistence {
  private readonly activeSession = new AsyncLocalStorage<string>();
  private readonly operations = new Map<string, Promise<void>>();

  private constructor(readonly stateRoot: string) {}

  static async open(homeDirectory?: string): Promise<Persistence> {
    return new Persistence(await initializeStateRoot(homeDirectory));
  }

  get sessionsDirectory(): string {
    return join(this.stateRoot, "sessions");
  }

  sessionDirectory(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    return join(this.sessionsDirectory, sessionId);
  }

  sessionFile(sessionId: string, filename: string): string {
    if (!SAFE_FILENAME.test(filename)) {
      throw new Error(`Invalid session filename: ${filename}`);
    }
    return join(this.sessionDirectory(sessionId), filename);
  }

  querySpoolFile(sessionId: string, spoolId: string): string {
    if (!SAFE_ID.test(spoolId)) {
      throw new Error(`Invalid query spool ID: ${spoolId}`);
    }
    return join(this.sessionDirectory(sessionId), "query-spools", `${spoolId}.ndjson`);
  }

  async initializeQuerySpoolDirectory(sessionId: string): Promise<void> {
    await ensurePrivateDirectory(join(this.sessionDirectory(sessionId), "query-spools"));
  }

  async clearQuerySpools(sessionId: string): Promise<void> {
    await rm(join(this.sessionDirectory(sessionId), "query-spools"), {
      force: true,
      recursive: true,
    });
  }

  logSortFile(sessionId: string, operationId: string, fileId: string): string {
    if (!SAFE_ID.test(operationId) || !SAFE_ID.test(fileId)) {
      throw new Error("Invalid log sort file identifier");
    }
    return join(this.sessionDirectory(sessionId), "log-sort", operationId, `${fileId}.ndjson`);
  }

  async initializeLogSortOperation(sessionId: string, operationId: string): Promise<void> {
    if (!SAFE_ID.test(operationId)) {
      throw new Error(`Invalid log sort operation ID: ${operationId}`);
    }
    const root = join(this.sessionDirectory(sessionId), "log-sort");
    await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(join(root, operationId));
  }

  async clearLogSortOperation(sessionId: string, operationId: string): Promise<void> {
    if (!SAFE_ID.test(operationId)) {
      throw new Error(`Invalid log sort operation ID: ${operationId}`);
    }
    await rm(join(this.sessionDirectory(sessionId), "log-sort", operationId), {
      force: true,
      recursive: true,
    });
  }

  async clearLogSortOperations(sessionId: string): Promise<void> {
    await rm(join(this.sessionDirectory(sessionId), "log-sort"), {
      force: true,
      recursive: true,
    });
  }

  async initializeSessionDirectory(sessionId: string): Promise<string> {
    const directory = this.sessionDirectory(sessionId);
    await ensurePrivateDirectory(directory);
    return directory;
  }

  async runSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeSession.getStore() === sessionId) {
      return operation();
    }
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const result = previous.then(() => this.activeSession.run(sessionId, operation));
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.operations.set(sessionId, settled);
    try {
      return await result;
    } finally {
      if (this.operations.get(sessionId) === settled) {
        this.operations.delete(sessionId);
      }
    }
  }

  async rejectSessionSymbolicLinks(sessionId: string): Promise<void> {
    await this.rejectSymbolicLink(this.sessionDirectory(sessionId));
    await Promise.all(
      OWNED_SESSION_FILES.map((filename) =>
        this.rejectSymbolicLink(this.sessionFile(sessionId, filename)),
      ),
    );
  }

  private async rejectSymbolicLink(path: string): Promise<void> {
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(`Session state must not be a symbolic link: ${path}`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
