import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonHealth, requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { Persistence } from "../../../src/daemon/persistence";
import { SessionRegistry } from "../../../src/daemon/session-registry";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("daemon session health", () => {
  test("reports persisted active sessions in authenticated health", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    await new SessionRegistry(persistence).create({
      activeRunId: "baseline",
      workspace: "/workspace/project",
    });
    const connection = await ensureDaemon({ homeDirectory: home });

    try {
      expect((await readDaemonHealth(connection))?.activeSessions).toBe(1);
    } finally {
      await requestDaemonShutdown(connection);
    }
  });
});
