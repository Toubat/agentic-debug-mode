import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { stopCommand } from "../../../src/commands/stop";
import { inspectProcess } from "../../../src/native/system";

const temporaryDirectories: string[] = [];
const spawnedPids: number[] = [];
let previousHomeOverride: string | undefined;

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGCONT");
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (previousHomeOverride === undefined) {
    delete process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE;
  } else {
    process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE = previousHomeOverride;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("stop against a wedged daemon", () => {
  const wedgeTest = process.platform === "win32" ? test.skip : test;

  wedgeTest(
    "terminates an alive-but-unresponsive daemon instead of reporting a false stop",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
      temporaryDirectories.push(home);
      previousHomeOverride = process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE;
      process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE = home;

      const connection = await ensureDaemon({ homeDirectory: home });
      spawnedPids.push(connection.pid);
      expect(inspectProcess(connection.pid).exists).toBe(true);

      // SIGSTOP models a daemon that is alive but cannot answer within the
      // shutdown or health-probe timeouts (busy, paged out, or wedged).
      process.kill(connection.pid, "SIGSTOP");

      const result = await stopCommand();
      expect(result.ok, JSON.stringify(result)).toBe(true);

      // stop reporting success must imply the recorded process is gone.
      const deadline = Date.now() + 5_000;
      let inspection = inspectProcess(connection.pid);
      while (inspection.exists && !inspection.zombie && Date.now() < deadline) {
        await Bun.sleep(50);
        inspection = inspectProcess(connection.pid);
      }
      expect(inspection.exists && !inspection.zombie).toBe(false);
    },
    20_000,
  );
});
