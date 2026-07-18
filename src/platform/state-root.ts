import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./permissions";

export function resolveStateRoot(homeDirectory = homedir()): string {
  return join(homeDirectory, ".agent-debug-mode");
}

async function rejectSymbolicLink(path: string, label: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link`);
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
  await rejectSymbolicLink(stateRoot, "State root");
  await ensurePrivateDirectory(stateRoot);
  await rejectSymbolicLink(stateRoot, "State root");
  for (const name of ["ready", "sessions", "tmp"]) {
    const directory = join(stateRoot, name);
    await rejectSymbolicLink(directory, "State directory");
    await ensurePrivateDirectory(directory);
    await rejectSymbolicLink(directory, "State directory");
  }
  return stateRoot;
}
