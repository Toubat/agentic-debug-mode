import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../platform/atomic-file";

export interface StartupLockOwner {
  nonce: string;
  pid: number;
  deadline: number;
}

export class StartupLock {
  private constructor(
    private readonly stateRoot: string,
    private readonly directory: string,
    readonly owner: StartupLockOwner,
  ) {}

  static async tryAcquire(
    stateRoot: string,
    owner: StartupLockOwner,
  ): Promise<StartupLock | undefined> {
    const directory = join(stateRoot, "startup.lock");
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        return undefined;
      }
      throw error;
    }
    const lock = new StartupLock(stateRoot, directory, owner);
    await writeJsonAtomic(join(directory, "owner.json"), owner);
    return lock;
  }

  static async readOwner(stateRoot: string): Promise<StartupLockOwner | undefined> {
    try {
      return JSON.parse(
        await readFile(join(stateRoot, "startup.lock", "owner.json"), "utf8"),
      ) as StartupLockOwner;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  static async breakIfOwnedBy(stateRoot: string, expected: StartupLockOwner): Promise<boolean> {
    const current = await StartupLock.readOwner(stateRoot);
    if (
      current?.nonce !== expected.nonce ||
      current.pid !== expected.pid ||
      current.deadline !== expected.deadline
    ) {
      return false;
    }
    await rm(join(stateRoot, "startup.lock"), {
      force: true,
      recursive: true,
    });
    return true;
  }

  static async breakIfUnownedAndOlderThan(
    stateRoot: string,
    ageMilliseconds: number,
  ): Promise<boolean> {
    const directory = join(stateRoot, "startup.lock");
    let age: number;
    try {
      age = Date.now() - (await stat(directory)).mtimeMs;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (age < ageMilliseconds || (await StartupLock.readOwner(stateRoot)) !== undefined) {
      return false;
    }
    await rm(directory, { force: true, recursive: true });
    return true;
  }

  async release(): Promise<void> {
    const owner = await StartupLock.readOwner(this.stateRoot);
    if (owner?.nonce === this.owner.nonce) {
      await rm(this.directory, { force: true, recursive: true });
    }
  }
}
