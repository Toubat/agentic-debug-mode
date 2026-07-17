import { chmod, mkdir, open } from "node:fs/promises";

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
  }
}

export async function ensurePrivateFile(path: string): Promise<void> {
  const file = await open(path, "a", 0o600);
  await file.close();
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }
}
