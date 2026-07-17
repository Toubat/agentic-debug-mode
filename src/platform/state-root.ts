import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./permissions";

export function resolveStateRoot(homeDirectory = homedir()): string {
  return join(homeDirectory, ".agent-debug-mode");
}

async function rejectSymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error("State root must not be a symbolic link");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function initializeStateRoot(homeDirectory = homedir()): Promise<string> {
  const stateRoot = resolveStateRoot(homeDirectory);
  await rejectSymbolicLink(stateRoot);
  await ensurePrivateDirectory(stateRoot);
  await rejectSymbolicLink(stateRoot);
  await Promise.all([
    ensurePrivateDirectory(join(stateRoot, "ready")),
    ensurePrivateDirectory(join(stateRoot, "sessions")),
    ensurePrivateDirectory(join(stateRoot, "tmp")),
  ]);
  return stateRoot;
}
