import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { getOrCreateControlToken } from "../../../src/daemon/auth";
import { Persistence } from "../../../src/daemon/persistence";
import type { DaemonConnection, DaemonMetadata } from "../../../src/daemon/protocol";
import { StartupLock } from "../../../src/daemon/startup-lock";
import { readReadyCandidate } from "../../../src/daemon/state-file";

const temporaryDirectories: string[] = [];
const root = join(import.meta.dir, "..", "..", "..");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function waitForCandidate(stateRoot: string, nonce: string): Promise<DaemonMetadata> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const candidate = await readReadyCandidate(stateRoot, nonce);
    if (candidate) {
      return candidate;
    }
    await Bun.sleep(20);
  }
  throw new Error("Orphan candidate did not become ready");
}

describe("ready candidate recovery", () => {
  test("adopts a healthy daemon when its original launcher died before publication", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const nonce = "orphan-candidate";
    await StartupLock.tryAcquire(persistence.stateRoot, {
      deadline: 0,
      nonce,
      pid: 4_294_967_295,
    });
    const child = Bun.spawn(
      [process.execPath, join(root, "src", "cli.ts"), "__daemon", "--nonce", nonce],
      {
        cwd: root,
        env: { ...process.env, AGENT_DEBUG_MODE_HOME_OVERRIDE: home },
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      },
    );
    child.unref();
    const candidate = await waitForCandidate(persistence.stateRoot, nonce);
    const token = await getOrCreateControlToken(persistence.stateRoot);
    let adopted: DaemonConnection | undefined;

    try {
      adopted = await ensureDaemon({ homeDirectory: home });
      expect(adopted.pid).toBe(candidate.pid);
      expect(adopted.nonce).toBe(nonce);
    } finally {
      if (adopted) {
        await requestDaemonShutdown(adopted);
      }
      if (!adopted || adopted.pid !== candidate.pid) {
        await requestDaemonShutdown({ ...candidate, controlToken: token });
      }
    }
  }, 10_000);
});
