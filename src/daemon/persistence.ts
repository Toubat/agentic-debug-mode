import { join } from "node:path";
import { ensurePrivateDirectory } from "../platform/permissions";
import { initializeStateRoot } from "../platform/state-root";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class Persistence {
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
    if (!SAFE_ID.test(filename.replace(/\.[a-z]+$/, ""))) {
      throw new Error(`Invalid session filename: ${filename}`);
    }
    return join(this.sessionDirectory(sessionId), filename);
  }

  async initializeSessionDirectory(sessionId: string): Promise<string> {
    const directory = this.sessionDirectory(sessionId);
    await ensurePrivateDirectory(directory);
    return directory;
  }
}
