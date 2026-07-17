import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { Persistence } from "../../../src/daemon/persistence";
import { ensurePrivateFile } from "../../../src/platform/permissions";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("control token recovery", () => {
  test("replaces an abandoned empty token file before daemon startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    await ensurePrivateFile(join(persistence.stateRoot, "control.token"));

    const connection = await ensureDaemon({ homeDirectory: home });

    expect(connection.controlToken).toHaveLength(43);
    await requestDaemonShutdown(connection);
  }, 5_000);
});
