import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import packageJson from "../../package.json";
import { getOrCreateControlToken } from "../daemon/auth";
import { Persistence } from "../daemon/persistence";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonConnection,
  type DaemonMetadata,
} from "../daemon/protocol";
import { StartupLock } from "../daemon/startup-lock";
import {
  readDaemonState,
  readReadyCandidate,
  removeReadyCandidate,
  writeDaemonState,
} from "../daemon/state-file";
import { inspectProcess, terminateIfIdentityMatches } from "../native/system";
import { readDaemonHealth, requestDaemonShutdown } from "./daemon-client";

export interface EnsureDaemonOptions {
  homeDirectory?: string;
}

function isCompatible(metadata: DaemonMetadata): boolean {
  return (
    metadata.protocolVersion === DAEMON_PROTOCOL_VERSION &&
    metadata.binaryVersion === packageJson.version
  );
}

async function readReusableConnection(
  stateRoot: string,
  controlToken: string,
): Promise<DaemonConnection | undefined> {
  const state = await readDaemonState(stateRoot);
  if (!state) {
    return undefined;
  }
  const connection = { ...state, controlToken };
  const health = await readDaemonHealth(connection);
  if (
    !health ||
    health.nonce !== state.nonce ||
    health.pid !== state.pid ||
    !isCompatible(health)
  ) {
    return undefined;
  }
  if (!isCompatible(state)) {
    await writeDaemonState(stateRoot, health);
  }
  return { ...health, controlToken };
}

function daemonCommand(): string[] {
  const sourceCli = join(import.meta.dir, "..", "cli.ts");
  if (basename(process.execPath).startsWith("bun") && existsSync(sourceCli)) {
    return [process.execPath, sourceCli, "__daemon"];
  }
  return [process.execPath, "__daemon"];
}

interface SpawnedDaemon {
  hasExited(): boolean;
}

class DaemonChildExitedError extends Error {}

function spawnDaemon(nonce: string, homeDirectory?: string): SpawnedDaemon {
  const child = Bun.spawn([...daemonCommand(), "--nonce", nonce], {
    env: {
      ...process.env,
      AGENT_DEBUG_MODE_HOME_OVERRIDE: homeDirectory,
    },
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
    windowsHide: true,
  });
  child.unref();
  return {
    hasExited: () => {
      const process = inspectProcess(child.pid);
      return !process.exists || process.zombie;
    },
  };
}

async function awaitReadyCandidate(
  stateRoot: string,
  nonce: string,
  controlToken: string,
  spawned: SpawnedDaemon,
): Promise<DaemonConnection> {
  const deadline = Date.now() + 10_000;
  let candidateSeen = false;
  let healthSeen = false;
  while (Date.now() < deadline) {
    const candidate = await readReadyCandidate(stateRoot, nonce);
    if (candidate) {
      candidateSeen = true;
      const connection = { ...candidate, controlToken };
      const health = await readDaemonHealth(connection);
      healthSeen ||= health !== undefined;
      if (health?.nonce === nonce && health.pid === candidate.pid && isCompatible(health)) {
        await writeDaemonState(stateRoot, health);
        await removeReadyCandidate(stateRoot, nonce);
        return { ...health, controlToken };
      }
    }
    if (spawned.hasExited()) {
      throw new DaemonChildExitedError("Daemon child exited before publishing a ready candidate");
    }
    await Bun.sleep(20);
  }
  throw new Error(
    `Daemon failed to become ready before the startup deadline (candidateSeen=${candidateSeen}, healthSeen=${healthSeen})`,
  );
}

async function tryAdoptReadyCandidate(
  stateRoot: string,
  nonce: string,
  controlToken: string,
): Promise<DaemonConnection | undefined> {
  const candidate = await readReadyCandidate(stateRoot, nonce);
  if (!candidate || !isCompatible(candidate)) {
    return undefined;
  }
  const connection = { ...candidate, controlToken };
  const health = await readDaemonHealth(connection);
  if (!health || health.nonce !== nonce || health.pid !== candidate.pid || !isCompatible(health)) {
    return undefined;
  }
  await writeDaemonState(stateRoot, health);
  await removeReadyCandidate(stateRoot, nonce);
  return { ...health, controlToken };
}

async function retireVerifiedStaleProcess(stateRoot: string, controlToken: string): Promise<void> {
  const state = await readDaemonState(stateRoot);
  if (!state) {
    return;
  }
  const connection = { ...state, controlToken };
  const health = await readDaemonHealth(connection);
  if (health) {
    if (isCompatible(health)) {
      return;
    }
    if ((health.activeSessions ?? 0) > 0) {
      throw new Error("An incompatible daemon has active sessions and cannot be replaced");
    }
    await requestDaemonShutdown(connection);
    return;
  }

  const process = inspectProcess(state.pid);
  if (
    !process.exists ||
    process.zombie ||
    process.startTime !== state.processIdentity.startTime ||
    process.executable !== state.processIdentity.executable
  ) {
    return;
  }
  const result = terminateIfIdentityMatches(state.pid, JSON.stringify(state.processIdentity));
  if (!result.terminated) {
    return;
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const current = inspectProcess(state.pid);
    if (!current.exists || current.zombie) {
      return;
    }
    await Bun.sleep(20);
  }

  const forced = terminateIfIdentityMatches(state.pid, JSON.stringify(state.processIdentity), true);
  if (!forced.terminated) {
    return;
  }
  const forcedDeadline = Date.now() + 2_000;
  while (Date.now() < forcedDeadline) {
    const current = inspectProcess(state.pid);
    if (!current.exists || current.zombie) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error("Verified stale daemon did not terminate after a forced signal");
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonConnection> {
  const persistence = await Persistence.open(options.homeDirectory);
  const controlToken = await getOrCreateControlToken(persistence.stateRoot);
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const reusable = await readReusableConnection(persistence.stateRoot, controlToken);
    if (reusable) {
      return reusable;
    }

    const nonce = randomUUID();
    const lock = await StartupLock.tryAcquire(persistence.stateRoot, {
      deadline,
      nonce,
      pid: process.pid,
    });
    if (!lock) {
      const owner = await StartupLock.readOwner(persistence.stateRoot);
      if (owner) {
        const adopted = await tryAdoptReadyCandidate(
          persistence.stateRoot,
          owner.nonce,
          controlToken,
        );
        if (adopted) {
          if (owner.deadline < Date.now()) {
            const process = inspectProcess(owner.pid);
            if (!process.exists || process.zombie) {
              await StartupLock.breakIfOwnedBy(persistence.stateRoot, owner);
            }
          }
          return adopted;
        }
      }
      if (owner && owner.deadline < Date.now()) {
        const process = inspectProcess(owner.pid);
        if (!process.exists || process.zombie) {
          await StartupLock.breakIfOwnedBy(persistence.stateRoot, owner);
        }
      } else if (!owner) {
        await StartupLock.breakIfUnownedAndOlderThan(persistence.stateRoot, 250);
      }
      await Bun.sleep(20);
      continue;
    }

    try {
      const rechecked = await readReusableConnection(persistence.stateRoot, controlToken);
      if (rechecked) {
        return rechecked;
      }
      await retireVerifiedStaleProcess(persistence.stateRoot, controlToken);
      let lastStartupError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let spawned: SpawnedDaemon;
        try {
          spawned = spawnDaemon(nonce, options.homeDirectory);
        } catch (error) {
          lastStartupError = error;
          await Bun.sleep(25 * (attempt + 1));
          continue;
        }
        try {
          return await awaitReadyCandidate(persistence.stateRoot, nonce, controlToken, spawned);
        } catch (error) {
          if (!(error instanceof DaemonChildExitedError)) {
            throw error;
          }
          lastStartupError = error;
          await Bun.sleep(25 * (attempt + 1));
        }
      }
      throw lastStartupError;
    } finally {
      await lock.release();
    }
  }

  throw new Error("Unable to acquire the daemon startup lock before the deadline");
}
