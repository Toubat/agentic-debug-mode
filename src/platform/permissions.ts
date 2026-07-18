import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";

async function rejectDirectorySymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error("Private directory must not be a symbolic link");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function rejectFileSymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error("Private file must not be a symbolic link");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await rejectDirectorySymbolicLink(path);
  await mkdir(path, { mode: 0o700, recursive: true });
  await rejectDirectorySymbolicLink(path);
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
  }
}

export async function ensurePrivateFile(path: string): Promise<void> {
  await rejectFileSymbolicLink(path);
  const flags =
    constants.O_APPEND |
    constants.O_CREAT |
    constants.O_WRONLY |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const file = await open(path, flags, 0o600);
  await file.close();
  await rejectFileSymbolicLink(path);
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }
}
