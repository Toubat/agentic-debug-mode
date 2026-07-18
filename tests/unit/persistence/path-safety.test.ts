import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Persistence } from "../../../src/daemon/persistence";
import { ensurePrivateFile } from "../../../src/platform/permissions";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("persistence path safety", () => {
  test("rejects session identifiers and filenames that could escape the state root", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);

    expect(() => persistence.sessionDirectory("../outside")).toThrow("Invalid session ID");
    expect(() => persistence.sessionFile("safe", "../../secret.json")).toThrow(
      "Invalid session filename",
    );
  });

  test("refuses a session directory redirected through a symbolic link", async () => {
    if (process.platform === "win32") {
      return;
    }
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    const redirected = await mkdtemp(join(tmpdir(), "agent-debug-mode-redirect-"));
    temporaryDirectories.push(home, redirected);
    const persistence = await Persistence.open(home);
    await symlink(redirected, persistence.sessionDirectory("session-1"));

    await expect(persistence.initializeSessionDirectory("session-1")).rejects.toThrow(
      "Private directory must not be a symbolic link",
    );
  });

  test("refuses private files redirected through symbolic links", async () => {
    if (process.platform === "win32") {
      return;
    }
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const target = join(home, "outside");
    await Bun.write(target, "do not modify");
    const redirected = join(persistence.stateRoot, "control.token");
    await symlink(target, redirected);

    await expect(ensurePrivateFile(redirected)).rejects.toThrow(
      "Private file must not be a symbolic link",
    );
    expect(await Bun.file(target).text()).toBe("do not modify");
  });
});
