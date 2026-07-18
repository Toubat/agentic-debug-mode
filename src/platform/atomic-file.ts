import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface RenameRetryOptions {
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  platform?: NodeJS.Platform;
}

/**
 * Rename a file, retrying briefly on Windows when the destination is transiently
 * locked (another process holds an open handle). Windows surfaces this as
 * EPERM/EACCES/EBUSY on rename; the holder typically releases within a few
 * milliseconds. POSIX behavior is unchanged: those codes are rethrown immediately.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  {
    rename: renameImpl = rename,
    sleep = defaultSleep,
    attempts = 10,
    platform = process.platform,
  }: RenameRetryOptions = {},
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable =
        platform === "win32" &&
        code !== undefined &&
        RENAME_RETRY_CODES.has(code) &&
        attempt < attempts - 1;
      if (!retryable) {
        throw error;
      }
      await sleep(5 + Math.floor(Math.random() * 5));
    }
  }
}

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
    await file.close();
    await renameWithRetry(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value)}\n`);
}

export async function readJsonFile<T = unknown>(path: string): Promise<T> {
  const file = await open(path, "r");
  try {
    return JSON.parse(await file.readFile("utf8")) as T;
  } finally {
    await file.close();
  }
}
