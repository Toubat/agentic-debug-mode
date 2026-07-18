import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function readPublishedToken(path: string): Promise<string | undefined> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const token = (await readFile(path, "utf8")).trim();
    if (/^[a-zA-Z0-9_-]{43}$/.test(token)) {
      return token;
    }
    await Bun.sleep(10);
  }
  return undefined;
}

export async function getOrCreateControlToken(stateRoot: string): Promise<string> {
  const path = join(stateRoot, "control.token");
  const token = randomBytes(32).toString("base64url");
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(`${token}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
    }
    return token;
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    const published = await readPublishedToken(path);
    if (published) {
      return published;
    }

    const quarantine = join(stateRoot, `.control.token.incomplete.${randomUUID()}`);
    try {
      await rename(path, quarantine);
      await rm(quarantine, { force: true });
    } catch (recoveryError) {
      if (
        !(
          recoveryError instanceof Error &&
          "code" in recoveryError &&
          recoveryError.code === "ENOENT"
        )
      ) {
        throw recoveryError;
      }
    }
    return getOrCreateControlToken(stateRoot);
  }
}

export function isAuthorized(request: Request, controlToken: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(controlToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
