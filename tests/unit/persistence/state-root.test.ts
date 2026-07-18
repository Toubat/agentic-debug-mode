import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStateRoot, resolveStateRoot } from "../../../src/platform/state-root";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("user state root", () => {
  test("creates the fixed home-relative layout with user-only permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);

    const stateRoot = await initializeStateRoot(home);

    expect(stateRoot).toBe(resolveStateRoot(home));
    expect(stateRoot).toBe(join(home, ".agent-debug-mode"));
    await expect(lstat(join(stateRoot, "sessions"))).resolves.toMatchObject({
      mode: process.platform === "win32" ? expect.any(Number) : expect.any(Number),
    });
    if (process.platform !== "win32") {
      expect((await lstat(stateRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(stateRoot, "sessions"))).mode & 0o777).toBe(0o700);
      expect((await lstat(join(stateRoot, "tmp"))).mode & 0o777).toBe(0o700);
    }
  });

  test("refuses a state root redirected through a symbolic link", async () => {
    if (process.platform === "win32") {
      return;
    }
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    const redirected = await mkdtemp(join(tmpdir(), "agent-debug-mode-redirect-"));
    temporaryDirectories.push(home, redirected);
    await symlink(redirected, resolveStateRoot(home));

    await expect(initializeStateRoot(home)).rejects.toThrow(
      "State root must not be a symbolic link",
    );
  });

  test("refuses state layout directories redirected through symbolic links", async () => {
    if (process.platform === "win32") {
      return;
    }
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    const redirected = await mkdtemp(join(tmpdir(), "agent-debug-mode-redirect-"));
    temporaryDirectories.push(home, redirected);
    const stateRoot = resolveStateRoot(home);
    await mkdir(stateRoot);
    await symlink(redirected, join(stateRoot, "sessions"));

    await expect(initializeStateRoot(home)).rejects.toThrow(
      "State directory must not be a symbolic link",
    );
  });
});
