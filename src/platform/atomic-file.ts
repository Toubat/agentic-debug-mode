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

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
    await file.close();
    await rename(temporaryPath, path);
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
