import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Persistence } from "../../../src/daemon/persistence";
import { SessionRegistry } from "../../../src/daemon/session-registry";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("session persistence", () => {
  test("keeps sessions isolated under the user state root", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const sessions = new SessionRegistry(persistence);

    const first = await sessions.create();
    const second = await sessions.create();

    expect(first.id).not.toBe(second.id);
    expect(await sessions.get(first.id)).toEqual(first);
    expect(await sessions.get(second.id)).toEqual(second);
  });
});
